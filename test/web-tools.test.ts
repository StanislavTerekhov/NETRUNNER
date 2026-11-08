// Web tools for the chat and the agents: search parsing, page text, permissions, address checks, repos, MCP.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatFileWrites, NetworkMode, WebSearchProvider } from '../electron/shared/ipc'
import { htmlToText, htmlTitle } from '../electron/main/services/html-text'
import { installPlan, parseDuckDuckGo, parseDuckDuckGoLite, WEB_TOOL_DEFS, WebTools, type WebToolDeps } from '../electron/main/services/web-tools'
import { McpToolServer } from '../electron/main/services/mcp-server'
import { buildOpencodeConfig } from '../electron/main/services/opencode'
import { fitToolResults } from '../electron/main/services/llamacpp'
import { searxngAddress } from '../electron/main/services/settings'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-web-'))
  temps.push(d)
  return d
}

const DDG = `
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
<div class="result results_links web-result"><div class="links_main result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1&amp;rut=x">Example <b>Docs</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">How to &amp; why <b>it</b> works</a>
</div></div>
<div class="result results_links web-result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://second.org/">Second</a></h2></div>`

const LITE = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Fp" class='result-link'>Lite result</a></td></tr>
<tr><td class='result-snippet'>A <b>snippet</b></td></tr></table>`

describe('search result parsing', () => {
  it('reads DuckDuckGo HTML results, unwraps redirect links and skips ads', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: 'Example Docs', url: 'https://example.com/docs?a=1', snippet: 'How to & why it works' },
      { title: 'Second', url: 'https://second.org/', snippet: '' },
    ])
  })
  it('reads the text-only page', () => {
    expect(parseDuckDuckGoLite(LITE)).toEqual([{ title: 'Lite result', url: 'https://lite.example/p', snippet: 'A snippet' }])
  })
})

describe('page text', () => {
  it('keeps the main content as light Markdown and drops scripts and navigation', () => {
    const html = `<html><head><title>T &amp; X</title><script>evil()</script></head><body><nav>menu</nav>
      <main><h1>Install</h1><p>Run <code>npm i x</code> &mdash; see <a href="/docs">the docs</a>.</p>
      <ul><li>one</li><li>two</li></ul><pre><code>const a = 1 &lt; 2
console.log(a)</code></pre>${'<p>filler text </p>'.repeat(40)}</main><footer>foot</footer></body></html>`
    const text = htmlToText(html, 'https://site.dev/page')
    expect(htmlTitle(html)).toBe('T & X')
    expect(text).toContain('# Install')
    expect(text).toContain('Run `npm i x` — see [the docs](https://site.dev/docs).')
    expect(text).toContain('- one\n- two')
    expect(text).toContain('```\nconst a = 1 < 2\nconsole.log(a)\n```')
    expect(text).not.toMatch(/evil|menu|foot/)
  })
})

type Call = { url: string; method: string }

function deps(over: Partial<WebToolDeps> & { answers?: boolean[]; mode?: NetworkMode; perm?: ChatFileWrites; provider?: WebSearchProvider; pages?: Record<string, { status?: number; body: string; type?: string; location?: string }> } = {}) {
  const calls: Call[] = []
  const asked: string[] = []
  const log: string[] = []
  const answers = over.answers ?? []
  const d: WebToolDeps = {
    networkMode: () => over.mode ?? 'online-tools',
    permission: () => over.perm ?? 'limited',
    provider: () => over.provider ?? 'duckduckgo',
    searxngUrl: () => null,
    secrets: () => ({ braveKey: null, googleKey: null, googleCx: null }),
    confirm: async m => (asked.push(m), answers.shift() ?? false),
    log: (host, _m, allowed, reason) => void log.push(`${allowed ? '+' : '-'}${host} ${reason}`),
    reposDir: over.reposDir ?? tmp(),
    childEnv: async () => ({}),
    // No real DNS in tests: every name is a public address, except one that resolves to a private one.
    resolve: async host => (host === 'rebind.example' ? ['10.0.0.5'] : ['93.184.215.14']),
    fetchImpl: (async (u: URL | string, init?: RequestInit) => {
      const url = String(u)
      calls.push({ url, method: init?.method ?? 'GET' })
      const p = over.pages?.[url] ?? { status: 404, body: 'not found' }
      return new Response(p.body, { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html', ...(p.location ? { location: p.location } : {}) } })
    }) as typeof fetch,
  }
  return { tools: new WebTools(d), calls, asked, log }
}

describe('web tools', () => {
  it('searches DuckDuckGo and formats the results for the model', async () => {
    const { tools, asked } = deps({ pages: { 'https://html.duckduckgo.com/html/': { body: DDG } } })
    const out = await tools.run('web_search', { query: 'example docs' })
    expect(out).toContain('1. Example Docs\n   https://example.com/docs?a=1\n   How to & why it works')
    expect(asked).toEqual([]) // limited: no question for searching
  })

  it('falls back to the lite page and reports a refusal instead of working around it', async () => {
    const lite = deps({ pages: { 'https://html.duckduckgo.com/html/': { status: 202, body: '' }, 'https://lite.duckduckgo.com/lite/': { body: LITE } } })
    expect(await lite.tools.run('web_search', { query: 'q' })).toContain('Lite result')
    const blocked = deps({ pages: { 'https://html.duckduckgo.com/html/': { status: 202, body: '' }, 'https://lite.duckduckgo.com/lite/': { status: 403, body: 'anomaly' } } })
    expect(await blocked.tools.run('web_search', { query: 'q' })).toMatch(/^Error: .*refused the request/)
  })

  it('asks in ASK mode and respects a refusal', async () => {
    const { tools, asked, calls } = deps({ perm: 'ask', answers: [false] })
    expect(await tools.run('web_search', { query: 'secret plans' })).toBe('Error: The operator declined this action')
    expect(asked[0]).toMatch(/secret plans/)
    expect(calls).toEqual([])
  })

  it('needs ONLINE TOOLS and never reaches local or private addresses, also via redirects', async () => {
    expect(await deps({ mode: 'local-network' }).tools.run('fetch_url', { url: 'https://example.com/' })).toMatch(/ONLINE TOOLS/)
    for (const url of ['http://127.0.0.1:8080/', 'http://192.168.1.10/', 'http://[::1]/', 'http://169.254.169.254/latest']) {
      expect(await deps().tools.run('fetch_url', { url })).toMatch(/local or private address/)
    }
    const r = deps({ pages: { 'https://example.com/go': { status: 302, body: '', location: 'http://127.0.0.1:9/x' } } })
    expect(await r.tools.run('fetch_url', { url: 'https://example.com/go' })).toMatch(/local or private address/)
    expect(r.calls.map(c => c.url)).toEqual(['https://example.com/go'])
    expect(await deps().tools.run('fetch_url', { url: 'file:///C:/Windows/win.ini' })).toMatch(/Only http/)
    // A public name that resolves to a private address (DNS rebinding) is refused too.
    expect(await deps().tools.run('fetch_url', { url: 'https://rebind.example/' })).toMatch(/local or private address/)
  })

  it('reads a page in parts', async () => {
    const body = `<html><body><main>${'<p>word </p>'.repeat(4000)}</main></body></html>`
    const { tools } = deps({ pages: { 'https://example.com/long': { body } } })
    const first = await tools.run('fetch_url', { url: 'https://example.com/long' })
    expect(first).toMatch(/call fetch_url with start=12000/)
    expect(await tools.run('fetch_url', { url: 'https://example.com/long', start: 12000 })).toContain('URL: https://example.com/long')
  })

  it('lists and reads downloaded repositories, inside the repo only', async () => {
    const reposDir = tmp()
    fs.mkdirSync(path.join(reposDir, 'demo', 'src'), { recursive: true })
    fs.writeFileSync(path.join(reposDir, 'demo', 'package.json'), '{}')
    fs.writeFileSync(path.join(reposDir, 'demo', 'src', 'a.js'), 'one\ntwo\n')
    const { tools } = deps({ reposDir })
    expect(await tools.run('repo_list', {})).toContain('- demo')
    expect(await tools.run('repo_list', { repo: 'demo' })).toMatch(/dir +src\/\n +package\.json/)
    expect(await tools.run('repo_read', { repo: 'demo', path: 'src/a.js' })).toContain('1: one\n2: two')
    expect(await tools.run('repo_read', { repo: 'demo', path: '../../etc' })).toMatch(/^Error/)
    expect(await tools.run('repo_read', { repo: '..', path: 'x' })).toMatch(/Invalid repository name/)
    expect(await installPlan(path.join(reposDir, 'demo'))).toEqual(['npm install'])
  })

  it('asks before cloning in LIMITED mode and accepts only https', async () => {
    const { tools, asked } = deps({ answers: [false] })
    expect(await tools.run('repo_clone', { url: 'https://github.com/owner/proj.git' })).toBe('Error: The operator declined this action')
    expect(asked[0]).toMatch(/github\.com\/owner\/proj/)
    expect(await tools.run('repo_clone', { url: 'git@github.com:o/p.git' })).toMatch(/^Error/)
    expect(await tools.run('repo_clone', { url: 'http://github.com/o/p' })).toMatch(/Only https/)
  })

  it('detects how a Python project installs', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests\n')
    expect(await installPlan(dir)).toEqual(['python -m venv .venv', '.venv\\Scripts\\python -m pip install -r requirements.txt'])
  })
})

describe('no internet: one clear answer instead of trying site after site', () => {
  const offline = (resolvable: string[] = []) => {
    const asked: string[] = []
    const d = deps()
    // Rebuild with a resolver that knows only \`resolvable\` and counts every lookup.
    const tools = new WebTools({
      ...(d.tools as unknown as { deps: WebToolDeps }).deps,
      resolve: async host => (asked.push(host), resolvable.includes(host) ? ['93.184.215.14'] : []),
    })
    return { tools, asked }
  }

  it('says NO_INTERNET when no well-known host resolves, then answers at once without lookups', async () => {
    const { tools, asked } = offline()
    const first = await tools.run('fetch_url', { url: 'https://github.com/ggml-org/llama.cpp/releases' })
    expect(first).toMatch(/^Error: NO_INTERNET: .*Do not call web tools again/)
    const lookups = asked.length
    expect(lookups).toBeGreaterThan(1) // the host itself plus the probes
    expect(await tools.run('web_search', { query: 'anything' })).toMatch(/^Error: NO_INTERNET/)
    expect(await tools.run('fetch_url', { url: 'https://example.com/' })).toMatch(/^Error: NO_INTERNET/)
    expect(asked.length).toBe(lookups)
  })

  it('one unknown site is just that site', async () => {
    const { tools } = offline(['github.com', 'cloudflare.com', 'wikipedia.org'])
    expect(await tools.run('fetch_url', { url: 'https://no-such-host.example/' })).toBe('Error: Cannot resolve no-such-host.example')
  })
})

describe('tool results fit the context', () => {
  // The case from a live run: six big GitHub API answers overflowed a 16K window (17 195 tokens).
  const conversation = () => {
    const m: Record<string, unknown>[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'latest llama.cpp release?' }]
    for (let i = 0; i < 6; i++) {
      m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'fetch_url', arguments: '{}' } }] })
      m.push({ role: 'tool', tool_call_id: `c${i}`, content: `${i}`.repeat(12_000) })
    }
    return m
  }
  const chars = (m: Record<string, unknown>[]) => m.reduce((n, x) => n + String(x.content ?? '').length + JSON.stringify(x.tool_calls ?? '').length, 0)

  it('shortens the oldest results first and keeps the newest whole while it fits', () => {
    const m = conversation()
    fitToolResults(m, 16384)
    expect(chars(m)).toBeLessThanOrEqual(16384 * 3 * 0.6)
    const tools = m.filter(x => x.role === 'tool').map(x => String(x.content))
    expect(tools[0]).toMatch(/shortened to save context/)
    expect(tools[5]).toBe('5'.repeat(12_000))
  })

  it('leaves a conversation that fits alone, and cuts everything down after a reported overflow', () => {
    const small = conversation().slice(0, 4)
    fitToolResults(small, 16384)
    expect(String(small[3].content)).toHaveLength(12_000)
    const m = conversation()
    fitToolResults(m, 16384, true)
    for (const t of m.filter(x => x.role === 'tool')) expect(String(t.content).length).toBeLessThan(700)
  })
})

describe('agents get the same tools over MCP', () => {
  it('answers initialize, tools/list and tools/call', async () => {
    const server = new McpToolServer({ defs: WEB_TOOL_DEFS, run: async (name, args) => `${name}:${JSON.stringify(args)}` })
    expect(await server.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
    const list = (await server.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map(t => t.name)).toEqual(WEB_TOOL_DEFS.map(d => d.name))
    expect(await server.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'x' } } })).toMatchObject({
      result: { content: [{ type: 'text', text: 'web_search:{"query":"x"}' }], isError: false },
    })
    expect(await server.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('refuses requests without the key over HTTP', async () => {
    const server = new McpToolServer({ defs: WEB_TOOL_DEFS, run: async () => 'ok' })
    const { url, key } = await server.start()
    try {
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
      const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
      expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    } finally {
      await server.stop()
    }
  })

  it('is registered in the OpenCode config, and the cloud websearch stays off', () => {
    const cfg = buildOpencodeConfig({ baseURL: 'http://127.0.0.1:5000', apiKey: 'k', label: 'm', contextLength: 8192 }, 'online-tools', { url: 'http://127.0.0.1:7/mcp', key: 'abc' }) as Record<string, any>
    expect(cfg.mcp.netrunner).toEqual({ type: 'remote', url: 'http://127.0.0.1:7/mcp', enabled: true, headers: { Authorization: 'Bearer abc' } })
    expect(cfg.permission.websearch).toBe('deny')
  })

  it('accepts only an http(s) origin as SearXNG address', () => {
    expect(searxngAddress('http://127.0.0.1:8888/search?q=x')).toBe('http://127.0.0.1:8888')
    expect(searxngAddress('javascript:alert(1)')).toBeNull()
    expect(searxngAddress('https://u:p@s.example')).toBeNull()
  })
})
