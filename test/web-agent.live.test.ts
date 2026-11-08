// Live: the real OpenCode binary connects to NETRUNNER's web tools MCP server and lists its tools.
// No model and no internet needed (the backend is never called). Opt-in: NETRUNNER_LIVE=1
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpToolServer } from '../electron/main/services/mcp-server'
import { OpenCodeService } from '../electron/main/services/opencode'
import { WEB_TOOL_DEFS } from '../electron/main/services/web-tools'

const LIVE = process.env.NETRUNNER_LIVE === '1'
const root = path.resolve(import.meta.dirname, '..')

/** Records which JSON-RPC methods OpenCode called. */
class RecordingServer extends McpToolServer {
  readonly methods: string[] = []
  override async rpc(m: Parameters<McpToolServer['rpc']>[0]) {
    this.methods.push(String(m?.method))
    return super.rpc(m)
  }
}

describe.skipIf(!LIVE)('agents get the web tools (live OpenCode)', () => {
  it('OpenCode connects to the MCP server and sees every web tool', async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-mcp-'))
    const mcp = new RecordingServer({ defs: WEB_TOOL_DEFS, run: async () => 'ok' })
    const agent = new OpenCodeService({
      binary: path.join(root, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
      dataDir: `${work}-opencode`,
      // A loopback backend that is never asked: listing tools needs no model.
      acquireModel: async () => ({ baseURL: 'http://127.0.0.1:9', apiKey: 'unused', label: 'none', contextLength: 8192 }),
      releaseModel: () => undefined,
      getMode: () => 'online-tools',
      proxyEnv: async () => ({}),
      webTools: () => mcp.start(),
      emit: () => undefined,
    })
    try {
      const state = await agent.start(work, 'none')
      const auth = (agent as unknown as { auth: string }).auth
      const res = await fetch(`${state.url}/mcp?directory=${encodeURIComponent(work)}`, { headers: { Authorization: auth } })
      const status = (await res.json()) as Record<string, { status: string; error?: string }>
      console.log(`[mcp] status ${JSON.stringify(status)} · methods ${mcp.methods.join(', ')}`)
      expect(status.netrunner?.status).toBe('connected')
      expect(mcp.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']))
    } finally {
      await agent.stop()
      await mcp.stop()
      await fs.rm(work, { recursive: true, force: true })
    }
  }, 120_000)
})
