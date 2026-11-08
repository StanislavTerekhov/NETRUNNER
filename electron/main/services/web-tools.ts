import { spawn, execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChatFileWrites, NetRules, NetworkMode, WebSearchProvider } from '../../shared/ipc'
import { assertOnlineAllowed, isLoopback, isPrivateLan, outboundDecision } from './endpoint-policy'
import { decodeEntities, htmlTitle, htmlToText } from './html-text'
import { resolveInWorkspace } from './workspace-path'
import { traffic } from './traffic'

/**
 * Web tools the local model can call (chat and agents): search, read a page, clone a repository, look into it,
 * install it and run commands in it. Network use needs ONLINE TOOLS; what is asked first follows the user's
 * WEB TOOLS mode — ask: everything; limited: search/read at once, clone/install/run asked; full: nothing asked.
 * Requests never go to loopback or private addresses (checked after DNS and on every redirect).
 */

export interface WebSecrets {
  braveKey: string | null
  googleKey: string | null
  googleCx: string | null
}

export interface WebToolDeps {
  networkMode(): NetworkMode
  permission(): ChatFileWrites
  provider(): WebSearchProvider
  searxngUrl(): string | null
  secrets(): WebSecrets
  confirm(message: string, detail: string): Promise<boolean>
  /** Network log entry for a request made here (allowed or refused). */
  log(host: string, method: string, allowed: boolean, reason: string): void
  reposDir: string
  /** Proxy environment for child processes (git, npm, pip), so their traffic follows the network mode too. */
  childEnv(): Promise<Record<string, string>>
  fetchImpl?: typeof fetch
  /** Host → IP addresses (default: the OS resolver). */
  resolve?: (host: string) => Promise<string[]>
  /** The operator's host rules (NETWORK → RULES). */
  rules?: () => NetRules
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const MAX_PAGE_BYTES = 3 * 1024 * 1024
const PAGE_CHARS = 12_000
const READ_LINES = 300
const OUTPUT_TAIL = 8_000
const INSTALL_TIMEOUT = 15 * 60_000
const RUN_TIMEOUT = 10 * 60_000

/** OpenAI-style tool definitions (llama-server tool calling and the agents' MCP server). */
export const WEB_TOOL_DEFS = [
  {
    name: 'web_search',
    description: 'Search the internet. Returns titles, URLs and snippets. Use it for anything you do not know or that may have changed; then read the best pages with fetch_url.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'integer', description: '1-10, default 8' } }, required: ['query'] },
  },
  {
    name: 'fetch_url',
    description: 'Read a web page (or a raw text/JSON/Markdown file) as plain text with links. Long pages come in parts: call again with start set to the offset given at the end.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL' }, start: { type: 'integer', description: 'Character offset, default 0' } }, required: ['url'] },
  },
  {
    name: 'repo_clone',
    description: 'Download (git clone, latest commit) a repository into the NETRUNNER repos folder. Returns its files, README start and how it would be installed.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'https URL of the git repository' }, name: { type: 'string', description: 'Folder name (optional)' } }, required: ['url'] },
  },
  {
    name: 'repo_list',
    description: 'List downloaded repositories (no repo given) or the files of a folder inside one.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string', description: 'Folder inside the repo, default root' } } },
  },
  {
    name: 'repo_read',
    description: `Read a text file of a downloaded repository (${READ_LINES} lines per call, numbered).`,
    parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, start_line: { type: 'integer', description: 'default 1' } }, required: ['repo', 'path'] },
  },
  {
    name: 'repo_install',
    description: 'Install the dependencies of a downloaded repository with its own tooling (npm/pnpm/yarn, Python venv + pip, cargo, go). Returns the output.',
    parameters: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  },
  {
    name: 'repo_run',
    description: 'Run a shell command (cmd.exe) inside a downloaded repository, e.g. its build, tests or a script from its README. Returns exit code and output.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, command: { type: 'string' } }, required: ['repo', 'command'] },
  },
] as const

export type WebToolName = (typeof WEB_TOOL_DEFS)[number]['name']

const isBlockedAddress = (host: string) => isLoopback(host) || isPrivateLan(host) || /^(0\.|169\.254\.|fe80:|fc|fd)/i.test(host) || host === '::'

// ---------------------------------------------------------------------------------------------
// Search providers (pure parsers are exported for tests)
// ---------------------------------------------------------------------------------------------

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** DuckDuckGo's HTML endpoint: result links go through /l/?uddg=<target>; ads are skipped. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = []
  // Split before each result <div>, keeping the tag, so its class (ads: "result--ad") can be checked.
  const blocks = html.split(/(?=<div[^>]+class="[^"]*\bresult\b)/).slice(1)
  for (const b of blocks) {
    if (/^<div[^>]+class="[^"]*result--ad/.test(b)) continue
    const a = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ?? b.match(/<a[^>]+href="([^"]+)"[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    let url = decodeEntities(a[1])
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snippet = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/)
    out.push({ title: stripTags(a[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' })
  }
  return out
}

/** The text-only DuckDuckGo page, used when the HTML one refuses. */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class=['"]result-link|$)/g
  for (const m of html.matchAll(re)) {
    let url = decodeEntities(m[1])
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (!/^https?:\/\//.test(url)) continue
    const snippet = m[3].match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)
    out.push({ title: stripTags(m[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' })
  }
  return out
}

export function formatResults(query: string, provider: string, results: SearchResult[]): string {
  if (!results.length) return `No results for "${query}" (${provider}).`
  return [`Search results for "${query}" (${provider}):`, ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)].join('\n')
}

/** Install commands for a repository, from the files it has. */
export async function installPlan(dir: string): Promise<string[]> {
  const has = async (f: string) => !!(await fs.stat(path.join(dir, f)).catch(() => null))
  const plan: string[] = []
  if (await has('package.json')) plan.push((await has('pnpm-lock.yaml')) ? 'pnpm install' : (await has('yarn.lock')) ? 'yarn install' : 'npm install')
  const req = await has('requirements.txt')
  const proj = (await has('pyproject.toml')) || (await has('setup.py'))
  if (req || proj) {
    plan.push('python -m venv .venv')
    if (req) plan.push('.venv\\Scripts\\python -m pip install -r requirements.txt')
    if (proj) plan.push('.venv\\Scripts\\python -m pip install -e .')
  }
  if (await has('Cargo.toml')) plan.push('cargo build')
  if (await has('go.mod')) plan.push('go mod download')
  return plan
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…(${s.length - OUTPUT_TAIL} earlier characters cut)\n${s.slice(-OUTPUT_TAIL)}` : s)

/** Marker the chat loop looks for: after it, the model gets no more tools in that answer. */
export const NO_INTERNET = 'NO_INTERNET'
/** Hosts asked when one name does not resolve, to tell "this site is down" from "this computer is offline". */
const PROBE_HOSTS = ['github.com', 'cloudflare.com', 'wikipedia.org']
/** How long "offline" is remembered: later calls fail at once instead of trying site after site. */
const OFFLINE_MEMORY_MS = 60_000

export class NoInternetError extends Error {
  constructor() {
    super(
      `${NO_INTERNET}: this computer has no internet connection right now (no host resolves, github.com and cloudflare.com included). ` +
        'Do not call web tools again in this answer: tell the operator you could not look it up and answer only from what you know, saying so.',
    )
    this.name = 'NoInternetError'
  }
}

export class WebTools {
  private readonly fetch: typeof fetch
  /** Until this time the computer is known to be offline (see NoInternetError). */
  private offlineUntil = 0

  constructor(private readonly deps: WebToolDeps) {
    this.fetch = deps.fetchImpl ?? fetch
  }

  /** Runs one tool call; failures come back as text so the model can react to them. */
  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    try {
      switch (name as WebToolName) {
        case 'web_search':
          return await this.search(str(args.query, 'query'), Math.min(10, Math.max(1, Number(args.max_results) || 8)), signal)
        case 'fetch_url':
          return await this.read(str(args.url, 'url'), Math.max(0, Number(args.start) || 0), signal)
        case 'repo_clone':
          return await this.clone(str(args.url, 'url'), typeof args.name === 'string' ? args.name : null)
        case 'repo_list':
          return await this.list(typeof args.repo === 'string' && args.repo ? args.repo : null, typeof args.path === 'string' ? args.path : '')
        case 'repo_read':
          return await this.readFile(str(args.repo, 'repo'), str(args.path, 'path'), Math.max(1, Number(args.start_line) || 1))
        case 'repo_install':
          return await this.install(str(args.repo, 'repo'))
        case 'repo_run':
          return await this.runCommand(str(args.repo, 'repo'), str(args.command, 'command'))
        default:
          return `Error: unknown tool ${name}`
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /** limited/full: reading the web needs no question; ask: it does. Changes on disk are asked unless full. */
  private async allow(kind: 'read' | 'change', message: string, detail: string): Promise<void> {
    const p = this.deps.permission()
    if (p === 'full' || (p === 'limited' && kind === 'read')) return
    if (!(await this.deps.confirm(message, detail))) throw new Error('The operator declined this action')
  }

  // ----- web -----

  private async assertPublic(url: URL, method: string): Promise<void> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) URLs')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    try {
      assertOnlineAllowed(this.deps.networkMode(), 'Web access')
    } catch (err) {
      this.deps.log(host, method, false, 'web tools: needs ONLINE TOOLS')
      throw err
    }
    // The operator's block list / allow-only list, as for the agents' and the terminal's traffic.
    const ruled = outboundDecision(host, this.deps.networkMode(), this.deps.rules?.())
    if (!ruled.allowed) {
      this.deps.log(host, method, false, `web tools: ${ruled.reason}`)
      throw new Error(`${host}: ${ruled.reason}`)
    }
    if (Date.now() < this.offlineUntil) throw new NoInternetError()
    const resolve = this.deps.resolve ?? (async (h: string) => (await lookup(h, { all: true }).catch(() => [])).map(a => a.address))
    const addresses = isBlockedAddress(host) ? [host] : await resolve(host)
    if (!addresses.length) {
      // One name failing may be that site; none of the well-known ones resolving means the computer is offline.
      const probes = await Promise.all(PROBE_HOSTS.filter(h => h !== host).map(h => resolve(h)))
      if (probes.every(a => !a.length)) {
        this.offlineUntil = Date.now() + OFFLINE_MEMORY_MS
        this.deps.log(host, method, false, 'web tools: no internet connection (DNS resolves no host)')
        throw new NoInternetError()
      }
      throw new Error(`Cannot resolve ${host}`)
    }
    this.offlineUntil = 0
    if (addresses.some(isBlockedAddress)) {
      this.deps.log(host, method, false, 'web tools: local/private address refused')
      throw new Error(`${host} is a local or private address; web tools only reach the internet`)
    }
    this.deps.log(host, method, true, 'web tools (ONLINE TOOLS)')
  }

  /** GET/POST with every redirect hop checked; body capped at MAX_PAGE_BYTES. */
  private async request(raw: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<{ url: string; type: string; text: string; status: number }> {
    let url = new URL(raw)
    for (let hop = 0; hop < 6; hop++) {
      await this.assertPublic(url, init.method ?? 'GET')
      const res = await this.fetch(url, {
        ...init,
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'en,ru;q=0.8', ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url)
        init = { ...init, method: 'GET', body: undefined }
        continue
      }
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      traffic.connection('web-tools')
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        traffic.add('web-tools', 0, value.length)
        size += value.length
        if (size > MAX_PAGE_BYTES) {
          await reader.cancel()
          break
        }
        chunks.push(value)
      }
      return { url: url.toString(), type: res.headers.get('content-type') ?? '', text: Buffer.concat(chunks).toString('utf8'), status: res.status }
    }
    throw new Error('Too many redirects')
  }

  private async search(query: string, n: number, signal?: AbortSignal): Promise<string> {
    await this.allow('read', `Search the web for "${query}"?`, `Provider: ${this.deps.provider()}`)
    const tried: string[] = []
    // The chosen provider first, DuckDuckGo as the fallback.
    for (const p of [...new Set([this.deps.provider(), 'duckduckgo' as const])]) {
      try {
        const results = (await this.searchWith(p, query, signal)).slice(0, n)
        if (results.length || p === 'duckduckgo') return formatResults(query, p, results)
        tried.push(`${p}: no results`)
      } catch (err) {
        if (err instanceof NoInternetError) throw err
        tried.push(`${p}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new Error(`search failed (${tried.join('; ')})`)
  }

  private async searchWith(p: WebSearchProvider, q: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const s = this.deps.secrets()
    if (p === 'searxng') {
      const base = this.deps.searxngUrl()
      if (!base) throw new Error('no SearXNG address set')
      assertOnlineAllowed(this.deps.networkMode(), 'Web search')
      // A SearXNG instance is usually the user's own (LAN or loopback): it is asked directly, not as a web page.
      const u = new URL('/search', base)
      u.search = new URLSearchParams({ q, format: 'json' }).toString()
      this.deps.log(u.hostname, 'GET', true, 'web search: SearXNG')
      const res = await this.fetch(u, { signal: signal ?? AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`SearXNG ${res.status} (is format=json enabled?)`)
      const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
      return (data.results ?? []).filter(r => r.url).map(r => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.content ?? '' }))
    }
    if (p === 'brave') {
      if (!s.braveKey) throw new Error('no Brave Search API key set')
      const u = new URL('https://api.search.brave.com/res/v1/web/search')
      u.search = new URLSearchParams({ q, count: '10' }).toString()
      await this.assertPublic(u, 'GET')
      const res = await this.fetch(u, { headers: { accept: 'application/json', 'X-Subscription-Token': s.braveKey }, signal: signal ?? AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Brave ${res.status}`)
      const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } }
      return (data.web?.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? '') }))
    }
    if (p === 'google') {
      if (!s.googleKey || !s.googleCx) throw new Error('no Google Custom Search key/engine id set')
      const u = new URL('https://www.googleapis.com/customsearch/v1')
      u.search = new URLSearchParams({ key: s.googleKey, cx: s.googleCx, q, num: '10' }).toString()
      await this.assertPublic(u, 'GET')
      const res = await this.fetch(u, { signal: signal ?? AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Google ${res.status}`)
      const data = (await res.json()) as { items?: { title: string; link: string; snippet?: string }[] }
      return (data.items ?? []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }))
    }
    // DuckDuckGo: the HTML page, then the text-only one. A challenge page is reported, never worked around.
    const body = new URLSearchParams({ q, kl: 'wt-wt' }).toString()
    const html = await this.request('https://html.duckduckgo.com/html/', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal })
    let results = html.status === 200 ? parseDuckDuckGo(html.text) : []
    if (!results.length) {
      const lite = await this.request('https://lite.duckduckgo.com/lite/', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal })
      results = lite.status === 200 ? parseDuckDuckGoLite(lite.text) : []
      if (!results.length && (lite.status !== 200 || /anomaly|captcha|challenge/i.test(lite.text))) {
        throw new Error('DuckDuckGo refused the request (rate limit or bot check); try again later or set SearXNG/Brave in WEB TOOLS')
      }
    }
    return results
  }

  private async read(url: string, start: number, signal?: AbortSignal): Promise<string> {
    await this.allow('read', `Read ${url}?`, '')
    const page = await this.request(url, { signal })
    if (page.status >= 400) return `HTTP ${page.status} for ${page.url}`
    let text: string
    let title = ''
    if (/html|xml/i.test(page.type) || /^\s*</.test(page.text)) {
      title = htmlTitle(page.text)
      text = htmlToText(page.text, page.url)
    } else if (/text|json|markdown|javascript|yaml|toml/i.test(page.type) || !page.type) text = page.text
    else return `${page.url}: ${page.type} is not text (binary files are not read)`
    const part = text.slice(start, start + PAGE_CHARS)
    const more = start + PAGE_CHARS < text.length ? `\n\n[${text.length - start - PAGE_CHARS} more characters: call fetch_url with start=${start + PAGE_CHARS}]` : ''
    return `${title ? `# ${title}\n` : ''}URL: ${page.url}\n\n${part}${more}`
  }

  // ----- repositories -----

  private repoDir(name: string): string {
    if (!/^[\w.-]{1,100}$/.test(name) || name.startsWith('.')) throw new Error(`Invalid repository name: ${name}`)
    return path.join(this.deps.reposDir, name)
  }

  private async existingRepo(name: string): Promise<string> {
    const dir = this.repoDir(name)
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`No downloaded repository "${name}" (repo_list shows them)`)
    return dir
  }

  private async clone(raw: string, wanted: string | null): Promise<string> {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:') throw new Error('Only https repository URLs')
    if (url.username || url.password) throw new Error('URLs with credentials are not accepted')
    const name = (wanted || url.pathname.split('/').filter(Boolean).slice(-1)[0] || '').replace(/\.git$/, '')
    const dir = this.repoDir(name)
    if (await fs.stat(dir).catch(() => null)) return `Already downloaded as "${name}" (${dir}).\n\n${await this.summary(name, dir)}`
    await this.allow('change', `Download repository ${url.toString()}?`, `git clone --depth 1 into\n${dir}`)
    await this.assertPublic(url, 'GIT')
    await fs.mkdir(this.deps.reposDir, { recursive: true })
    const out = await this.exec('git', ['clone', '--depth', '1', '--', url.toString(), dir], this.deps.reposDir, INSTALL_TIMEOUT)
    if (out.code !== 0) throw new Error(`git clone failed (${out.code}):\n${tail(out.output)}`)
    return `Downloaded "${name}" to ${dir}.\n\n${await this.summary(name, dir)}`
  }

  private async summary(name: string, dir: string): Promise<string> {
    const listing = await this.list(name, '')
    const readme = (await fs.readdir(dir)).find(f => /^readme(\.(md|rst|txt))?$/i.test(f))
    const text = readme ? (await fs.readFile(path.join(dir, readme), 'utf8')).slice(0, 3000) : ''
    const plan = await installPlan(dir)
    return `${listing}\n\n${readme ? `${readme} (start):\n${text}\n\n` : ''}Install plan (repo_install): ${plan.length ? plan.join(' && ') : 'nothing detected — read the README and use repo_run'}`
  }

  private async list(name: string | null, rel: string): Promise<string> {
    if (!name) {
      const entries = (await fs.readdir(this.deps.reposDir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory())
      return entries.length ? `Downloaded repositories (${this.deps.reposDir}):\n${entries.map(e => `- ${e.name}`).join('\n')}` : 'No repositories downloaded yet.'
    }
    const root = await this.existingRepo(name)
    const dir = rel ? resolveInWorkspace(root, rel) : root
    const entries = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.name !== '.git')
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    const shown = entries.slice(0, 300).map(e => `${e.isDirectory() ? 'dir ' : '    '} ${e.name}${e.isDirectory() ? '/' : ''}`)
    return `${name}/${rel}${rel && !rel.endsWith('/') ? '/' : ''} (${entries.length} entries)\n${shown.join('\n')}${entries.length > 300 ? '\n…' : ''}`
  }

  private async readFile(name: string, rel: string, startLine: number): Promise<string> {
    const root = await this.existingRepo(name)
    const file = resolveInWorkspace(root, rel)
    const real = await fs.realpath(file)
    if (path.relative(await fs.realpath(root), real).startsWith('..')) throw new Error('Path leaves the repository')
    const stat = await fs.stat(real)
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`)
    if (stat.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB')
    const buf = await fs.readFile(real)
    if (buf.subarray(0, 8000).includes(0)) throw new Error('Binary file')
    const lines = buf.toString('utf8').split('\n')
    const part = lines.slice(startLine - 1, startLine - 1 + READ_LINES)
    const more = startLine - 1 + READ_LINES < lines.length ? `\n[${lines.length - (startLine - 1 + READ_LINES)} more lines: start_line=${startLine + READ_LINES}]` : ''
    return `${name}/${rel} (lines ${startLine}-${startLine + part.length - 1} of ${lines.length})\n${part.map((l, i) => `${startLine + i}: ${l}`).join('\n')}${more}`
  }

  private async install(name: string): Promise<string> {
    const dir = await this.existingRepo(name)
    const plan = await installPlan(dir)
    if (!plan.length) return 'No install files found (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod). Read the README and use repo_run.'
    assertOnlineAllowed(this.deps.networkMode(), 'Installing dependencies')
    await this.allow('change', `Install ${name}?`, `In ${dir}:\n${plan.join('\n')}\n\nInstall scripts of the repository run with your user rights.`)
    const out: string[] = []
    for (const cmd of plan) {
      const r = await this.shell(cmd, dir, INSTALL_TIMEOUT)
      out.push(`$ ${cmd}\n(exit ${r.code})\n${tail(r.output)}`)
      if (r.code !== 0) break
    }
    return out.join('\n\n')
  }

  private async runCommand(name: string, command: string): Promise<string> {
    const dir = await this.existingRepo(name)
    if (command.length > 2000) throw new Error('Command too long')
    await this.allow('change', `Run a command in ${name}?`, `In ${dir}:\n${command}`)
    const r = await this.shell(command, dir, RUN_TIMEOUT)
    return `$ ${command}\n(exit ${r.code})\n${tail(r.output)}`
  }

  private async shell(command: string, cwd: string, timeout: number): Promise<{ code: number; output: string }> {
    // /s: cmd strips the outer quotes and runs the rest exactly as written.
    return this.exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], cwd, timeout, true)
  }

  private async exec(file: string, args: string[], cwd: string, timeout: number, verbatim = false): Promise<{ code: number; output: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await this.deps.childEnv()), GIT_TERMINAL_PROMPT: '0' }
    return new Promise(resolve => {
      const child = spawn(file, args, { cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim })
      let output = ''
      const add = (d: Buffer) => {
        output += d.toString('utf8')
        if (output.length > 4 * OUTPUT_TAIL) output = output.slice(-2 * OUTPUT_TAIL)
      }
      child.stdout.on('data', add)
      child.stderr.on('data', add)
      const timer = setTimeout(() => {
        output += `\n[stopped after ${timeout / 60_000} min]`
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined)
        else child.kill()
      }, timeout)
      child.on('error', err => {
        clearTimeout(timer)
        resolve({ code: -1, output: `${output}\n${err.message}` })
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, output })
      })
    })
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`)
  return v.trim()
}
