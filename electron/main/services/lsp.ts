import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace-path'

/** A byte stream to one language server process (stdio pipes, or a socket for Electron utility processes). */
export interface LspTransport {
  write(data: Buffer): void
  onData(cb: (data: Buffer) => void): void
  onExit(cb: (reason: string) => void): void
  kill(): void
}

export interface LspServerDef {
  id: string
  label: string
  /** Monaco language ids this server handles. */
  languages: string[]
  /** Start the server for a workspace, or null when it is not installed. */
  launch: (root: string) => Promise<LspTransport> | null
}

export type LspState = 'stopped' | 'starting' | 'running' | 'unavailable' | 'error'
export interface LspStatus {
  id: string
  label: string
  languages: string[]
  state: LspState
  detail: string | null
}

export type LspFeature = 'completion' | 'hover' | 'definition' | 'signatureHelp'

/** Content-Length framed JSON-RPC (the LSP base protocol). Feed bytes in, get messages out. */
export class LspFramer {
  private buf = Buffer.alloc(0)
  push(data: Buffer, onMessage: (msg: Record<string, unknown>) => void): void {
    this.buf = Buffer.concat([this.buf, data])
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buf.subarray(0, headerEnd).toString('ascii')
      const len = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? NaN)
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(headerEnd + 4) // malformed header: skip it
        continue
      }
      if (this.buf.length < headerEnd + 4 + len) return
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(headerEnd + 4 + len)
      try {
        onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        /* ignore an unparsable message */
      }
    }
  }
}

export const frame = (msg: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** One running language server: requests with ids, notifications, and answers to the server's own requests. */
class Connection {
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly framer = new LspFramer()

  constructor(
    private readonly t: LspTransport,
    private readonly onNotification: (method: string, params: unknown) => void,
  ) {
    t.onData(d => this.framer.push(d, m => this.dispatch(m)))
    t.onExit(reason => {
      for (const p of this.pending.values()) p.reject(new Error(`language server exited: ${reason}`))
      this.pending.clear()
    })
  }

  private dispatch(m: Record<string, unknown>): void {
    if ('id' in m && ('result' in m || 'error' in m) && !('method' in m)) {
      const p = this.pending.get(Number(m.id))
      if (!p) return
      this.pending.delete(Number(m.id))
      if (m.error) p.reject(new Error(String((m.error as { message?: string }).message ?? 'LSP error')))
      else p.resolve(m.result)
      return
    }
    if (typeof m.method !== 'string') return
    if ('id' in m) {
      // A request from the server: answer with neutral defaults (no client-side configuration).
      const params = m.params as { items?: unknown[] } | undefined
      const result = m.method === 'workspace/configuration' ? (params?.items ?? []).map(() => ({})) : null
      this.t.write(frame({ jsonrpc: '2.0', id: m.id, result }))
      return
    }
    this.onNotification(m.method, m.params)
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    const id = ++this.seq
    this.t.write(frame({ jsonrpc: '2.0', id, method, params }))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v as T)),
        reject: e => (clearTimeout(timer), reject(e)),
      })
    })
  }

  notify(method: string, params: unknown): void {
    this.t.write(frame({ jsonrpc: '2.0', method, params }))
  }

  kill(): void {
    this.t.kill()
  }
}

/** stdio transport for a server binary found on PATH. */
export function stdioTransport(cmd: string, args: string[], cwd: string): LspTransport {
  const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  return {
    write: d => void p.stdin.write(d),
    onData: cb => void p.stdout.on('data', cb),
    onExit: cb => {
      p.once('exit', code => cb(`code ${code}`))
      p.once('error', err => cb(err.message))
    },
    kill: () => void p.kill(),
  }
}

/** A server executable on PATH (Windows: .exe / .cmd). */
export function onPath(name: string, pathEnv = process.env.PATH ?? process.env.Path ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/** Language servers used when installed on PATH (Python has its own bundled pyright). */
export function pathServers(): LspServerDef[] {
  const def = (id: string, label: string, languages: string[], cmd: string, args: string[]): LspServerDef => ({
    id,
    label,
    languages,
    launch: root => {
      const exe = onPath(cmd)
      return exe ? Promise.resolve(stdioTransport(exe, args, root)) : null
    },
  })
  return [
    def('rust', 'rust-analyzer', ['rust'], 'rust-analyzer', []),
    def('go', 'gopls', ['go'], 'gopls', ['serve']),
    def('cpp', 'clangd', ['c', 'cpp'], 'clangd', []),
  ]
}

interface Doc {
  version: number
  server: string
}

/**
 * Language servers for the editor (completion, hover, go to definition, signatures, diagnostics). One process per
 * language for the open workspace, started when the first file of that language opens. Paths cross the IPC
 * boundary only as workspace-relative paths; file URIs are built and checked here.
 */
export class LspService {
  private readonly conns = new Map<string, Promise<Connection>>()
  private readonly state = new Map<string, { state: LspState; detail: string | null }>()
  private readonly docs = new Map<string, Doc>()

  constructor(
    private readonly defs: LspServerDef[],
    private readonly getRoot: () => string | null,
    private readonly onDiagnostics: (relPath: string, diagnostics: unknown[]) => void,
    private readonly onStatus: () => void = () => undefined,
  ) {}

  status(): LspStatus[] {
    return this.defs.map(d => ({ id: d.id, label: d.label, languages: d.languages, ...(this.state.get(d.id) ?? { state: 'stopped' as const, detail: null }) }))
  }

  private setState(id: string, state: LspState, detail: string | null = null): void {
    this.state.set(id, { state, detail })
    this.onStatus()
  }

  private root(): string {
    const r = this.getRoot()
    if (!r) throw new Error('No workspace is open')
    return r
  }

  private uri(relPath: string): string {
    return pathToFileURL(resolveInWorkspace(this.root(), relPath)).href
  }

  /** Workspace-relative path of a server URI, or null when it points outside the workspace (e.g. typeshed stubs). */
  private rel(uri: string): string | null {
    try {
      const abs = fileURLToPath(uri)
      const rel = toWorkspaceRelative(this.root(), abs)
      return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
    } catch {
      return null
    }
  }

  private connect(def: LspServerDef): Promise<Connection> | null {
    const existing = this.conns.get(def.id)
    if (existing) return existing
    const root = this.root()
    const launched = def.launch(root)
    if (!launched) {
      this.setState(def.id, 'unavailable', `${def.label} is not installed`)
      return null
    }
    this.setState(def.id, 'starting')
    const p = (async () => {
      const t = await launched
      const conn = new Connection(t, (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return
        const { uri, diagnostics } = params as { uri: string; diagnostics: unknown[] }
        const rel = this.rel(uri)
        if (rel !== null) this.onDiagnostics(rel, diagnostics)
      })
      t.onExit(reason => {
        if (this.conns.get(def.id) === p) {
          this.conns.delete(def.id)
          for (const [k, d] of this.docs) if (d.server === def.id) this.docs.delete(k)
          this.setState(def.id, 'error', `exited (${reason})`)
        }
      })
      const rootUri = pathToFileURL(root).href
      await conn.request(
        'initialize',
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: true, dynamicRegistration: false },
              completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: false },
              signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: { configuration: true, workspaceFolders: true },
          },
        },
        60000,
      )
      conn.notify('initialized', {})
      conn.notify('workspace/didChangeConfiguration', { settings: {} })
      this.setState(def.id, 'running')
      return conn
    })()
    p.catch(err => {
      if (this.conns.get(def.id) === p) this.conns.delete(def.id)
      this.setState(def.id, 'error', err instanceof Error ? err.message : String(err))
    })
    this.conns.set(def.id, p)
    return p
  }

  private defFor(languageId: string): LspServerDef | null {
    return this.defs.find(d => d.languages.includes(languageId)) ?? null
  }

  /** Start tracking a document; false when no server handles the language. */
  async open(relPath: string, languageId: string, text: string): Promise<boolean> {
    const def = this.defFor(languageId)
    if (!def) return false
    const conn = this.connect(def)
    if (!conn) return false
    const c = await conn
    const doc = { version: 1, server: def.id }
    this.docs.set(relPath, doc)
    c.notify('textDocument/didOpen', { textDocument: { uri: this.uri(relPath), languageId, version: doc.version, text } })
    return true
  }

  async change(relPath: string, text: string): Promise<void> {
    const doc = this.docs.get(relPath)
    if (!doc) return
    const c = await this.conns.get(doc.server)
    doc.version++
    c?.notify('textDocument/didChange', { textDocument: { uri: this.uri(relPath), version: doc.version }, contentChanges: [{ text }] })
  }

  async close(relPath: string): Promise<void> {
    const doc = this.docs.get(relPath)
    if (!doc) return
    this.docs.delete(relPath)
    ;(await this.conns.get(doc.server))?.notify('textDocument/didClose', { textDocument: { uri: this.uri(relPath) } })
  }

  async saved(relPath: string): Promise<void> {
    const doc = this.docs.get(relPath)
    if (doc) (await this.conns.get(doc.server))?.notify('textDocument/didSave', { textDocument: { uri: this.uri(relPath) } })
  }

  /** One editor feature at a position. Definitions come back as workspace-relative paths (outside → dropped). */
  async request(relPath: string, feature: LspFeature, position: { line: number; character: number }): Promise<unknown> {
    const doc = this.docs.get(relPath)
    if (!doc) return null
    const c = await this.conns.get(doc.server)
    if (!c) return null
    const params = { textDocument: { uri: this.uri(relPath) }, position }
    const method = { completion: 'textDocument/completion', hover: 'textDocument/hover', definition: 'textDocument/definition', signatureHelp: 'textDocument/signatureHelp' }[feature]
    const result = await c.request(method, params)
    if (feature !== 'definition' || !result) return result
    const list = (Array.isArray(result) ? result : [result]) as { uri?: string; targetUri?: string; range?: unknown; targetSelectionRange?: unknown }[]
    return list
      .map(l => ({ path: this.rel(l.uri ?? l.targetUri ?? ''), range: l.range ?? l.targetSelectionRange }))
      .filter(l => l.path !== null)
  }

  /** Stop every server (workspace switch, app quit). */
  async stopAll(): Promise<void> {
    const all = [...this.conns.entries()]
    this.conns.clear()
    this.docs.clear()
    for (const [id, p] of all) {
      try {
        const c = await p
        await c.request('shutdown', null, 3000).catch(() => undefined)
        c.notify('exit', null)
        setTimeout(() => c.kill(), 500)
      } catch {
        /* already gone */
      }
      this.setState(id, 'stopped')
    }
  }
}
