import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { NetLogEntry, NetRules, NetworkMode } from '../../shared/ipc'
import { outboundDecision } from './endpoint-policy'
import { traffic } from './traffic'

const MAX_LOG = 1000

/**
 * Local HTTP(S) proxy that every tool process (OpenCode and the commands it runs) is pointed at via
 * HTTP_PROXY/HTTPS_PROXY. It enforces the network mode per connection and logs every attempt.
 * Limitation: a program that ignores proxy variables and opens raw sockets is not covered — that needs
 * the OS firewall (documented; phase 5).
 */
export class NetProxy {
  private server: http.Server | null = null
  private seq = 0
  readonly log: NetLogEntry[] = []

  constructor(
    private readonly getMode: () => NetworkMode,
    private readonly onEntry: (e: NetLogEntry) => void = () => undefined,
    /** The operator's host rules (NETWORK → RULES), applied on top of the mode. */
    private readonly getRules: () => NetRules | undefined = () => undefined,
  ) {}

  get port(): number | null {
    const addr = this.server?.address() as AddressInfo | null
    return addr ? addr.port : null
  }

  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  private record(source: string, method: string, host: string, port: number): NetLogEntry {
    const { allowed, reason } = outboundDecision(host, this.getMode(), this.getRules())
    const entry: NetLogEntry = { id: ++this.seq, time: new Date().toISOString(), source, method, host, port, allowed, reason }
    this.log.push(entry)
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
    this.onEntry(entry)
    return entry
  }

  async start(source = 'agent'): Promise<string> {
    if (this.server) return this.url!
    const server = http.createServer((req, res) => {
      req.on('error', () => res.destroy())
      // Plain HTTP proxying: the request line carries an absolute URL.
      let target: URL
      try {
        target = new URL(req.url ?? '')
      } catch {
        res.writeHead(400).end('NETRUNNER proxy: absolute URL required')
        return
      }
      const port = Number(target.port) || 80
      const entry = this.record(source, req.method ?? 'GET', target.hostname, port)
      if (!entry.allowed) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by NETRUNNER network policy: ${entry.reason}`)
        return
      }
      traffic.connection(source)
      req.on('data', (c: Buffer) => traffic.add(source, c.length, 0))
      const upstream = http.request(
        { host: target.hostname, port, method: req.method, path: target.pathname + target.search, headers: req.headers },
        up => {
          up.on('data', (c: Buffer) => traffic.add(source, 0, c.length))
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', err => res.writeHead(502).end(String(err)))
      req.pipe(upstream)
    })

    // Clients (or their killed processes) may reset sockets at any time; that must never crash the app.
    server.on('clientError', (_err, socket) => socket.destroy())
    server.on('connect', (req, clientSocket: net.Socket, head) => {
      clientSocket.on('error', () => clientSocket.destroy())
      const [host, portStr] = (req.url ?? '').split(/:(?=\d+$)/)
      const port = Number(portStr) || 443
      const entry = this.record(source, 'CONNECT', host, port)
      if (!entry.allowed) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by NETRUNNER network policy: ${entry.reason}`)
        return
      }
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      traffic.connection(source)
      // Tunnel bytes (TLS included) as they cross the upstream socket.
      upstream.on('close', () => traffic.add(source, upstream.bytesWritten, upstream.bytesRead))
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('close', () => upstream.destroy())
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    return this.url!
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) await new Promise<void>(r => s.close(() => r()))
  }

  /** Environment for a child process so its HTTP clients go through this proxy. */
  childEnv(): Record<string, string> {
    const url = this.url
    if (!url) throw new Error('Proxy not started')
    const noProxy = '127.0.0.1,localhost,::1'
    return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy }
  }
}
