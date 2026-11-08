import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChatTools } from './llamacpp'

/**
 * The web tools for the agents: a minimal MCP server (Streamable HTTP, JSON responses) on loopback with a random
 * key per launch, registered in OpenCode's config. Only initialize, tools/list and tools/call are implemented.
 */
export class McpToolServer {
  private server: http.Server | null = null
  private readonly key = crypto.randomBytes(24).toString('hex')
  private url: string | null = null

  constructor(
    private readonly tools: ChatTools,
    private readonly info = { name: 'netrunner', version: '1' },
  ) {}

  async start(): Promise<{ url: string; key: string }> {
    if (this.url) return { url: this.url, key: this.key }
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`
    return { url: this.url, key: this.key }
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.url = null
    if (s) await new Promise<void>(resolve => s.close(() => resolve()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? ''
    const expected = `Bearer ${this.key}`
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      res.writeHead(401).end()
      return
    }
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    // No server-initiated stream and no sessions to end.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 1_000_000) {
        res.writeHead(413).end()
        return
      }
    }
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const batch = Array.isArray(msg)
    const messages = (batch ? msg : [msg]) as Rpc[]
    const replies = (await Promise.all(messages.map(m => this.rpc(m)))).filter((r): r is object => r !== null)
    if (!replies.length) {
      res.writeHead(202).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? replies : replies[0]))
  }

  /** One JSON-RPC message; notifications (no id) get no reply. */
  async rpc(m: Rpc): Promise<object | null> {
    const id = m?.id ?? null
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    if (id === null) return null
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        })
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: this.tools.defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.parameters })) })
      case 'tools/call': {
        const name = String(m.params?.name ?? '')
        if (!this.tools.defs.some(d => d.name === name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } }
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>
        const text = await this.tools.run(name, args, AbortSignal.timeout(20 * 60_000))
        return ok({ content: [{ type: 'text', text }], isError: text.startsWith('Error:') })
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } }
    }
  }
}

interface Rpc {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown> & { protocolVersion?: unknown; name?: unknown; arguments?: unknown }
}
