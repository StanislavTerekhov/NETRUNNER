// Live end-to-end test of the agent stack against the real OpenCode binary and a local llama-server.
// Opt-in: NETRUNNER_LIVE=1 [NETRUNNER_LIVE_MODEL=<model id>] npx vitest run test/agent.live.test.ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentPart } from '../electron/shared/ipc'
import { GitService } from '../electron/main/services/git'
import { findRuntimeDir, LlamaRuntime, resolveRoles } from '../electron/main/services/llamacpp'
import { NetProxy } from '../electron/main/services/net-proxy'
import { OpenCodeService } from '../electron/main/services/opencode'

const LIVE = process.env.NETRUNNER_LIVE === '1'
const root = path.resolve(import.meta.dirname, '..')
const home = path.join(os.homedir(), 'NETRUNNER')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

function runTests(cwd: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync('node', ['--test'], { cwd, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe.skipIf(!LIVE)('agent end-to-end (live)', () => {
  it(
    'debugger agent fixes a failing test with approvals, offline, and the checkpoint can revert it',
    async () => {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-agent-'))
      await fs.cp(path.join(root, 'test', 'fixtures', 'agent-sample'), work, { recursive: true })
      const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' })
      git('init', '-q')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture')

      expect(runTests(work).ok).toBe(false) // the fixture really fails before the agent runs

      const gitService = new GitService(() => work)
      const checkpoint = await gitService.checkpoint('before agent')

      const proxy = new NetProxy(() => 'strict-offline')
      const events: AgentEvent[] = []
      const permissions: { type: string; title: string; pattern: string[] }[] = []
      let agent: OpenCodeService
      let sessionId = ''
      let idleResolve: () => void = () => undefined
      let sawBusy = false
      const idle = new Promise<void>(r => (idleResolve = r))

      agent = new OpenCodeService({
        binary: path.join(root, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
        dataDir: path.join(work, '..', `${path.basename(work)}-opencode`),
        acquireModel: async model => {
          const s = await runtime.ensure('chat', model, 65536)
          runtime.pinned = model
          return { baseURL: s.url, apiKey: s.key, label: model, contextLength: s.ctx }
        },
        releaseModel: () => {
          runtime.pinned = null
        },
        getMode: () => 'strict-offline',
        proxyEnv: async () => {
          await proxy.start('agent')
          return proxy.childEnv()
        },
        emit: ev => {
          events.push(ev)
          if (ev.type === 'permission') {
            permissions.push({ type: ev.permission.type, title: ev.permission.title, pattern: ev.permission.pattern })
            console.log(`[permission] ${ev.permission.type}: ${ev.permission.title} → approve once`)
            // The test plays the operator and approves each request individually.
            agent.respond(ev.permission.sessionId, ev.permission.id, 'once').catch(e => console.log(`[permission] reply failed: ${e}`))
          }
          if (ev.type === 'status' && ev.sessionId === sessionId) {
            if (ev.busy) sawBusy = true
            else if (sawBusy) idleResolve()
          }
          if (ev.type === 'part' && ev.part.kind === 'tool' && (ev.part.status === 'completed' || ev.part.status === 'error')) {
            console.log(`[tool] ${ev.part.tool} ${ev.part.status}: ${ev.part.title} ${ev.part.error ?? ''}`)
          }
          if (ev.type === 'error') console.log(`[error] ${ev.message}`)
        },
      })

      const started = Date.now()
      try {
        const model =
          process.env.NETRUNNER_LIVE_MODEL ?? resolveRoles(await runtime.catalog.list(), { defaultModel: null, agentModel: null, embeddingModel: null }).agent
        if (!model) throw new Error('no agent model installed')
        console.log(`[agent] model ${model}`)
        const state = await agent.start(work, model)
        console.log(`[agent] OpenCode ${state.version} at ${state.url}`)
        const session = await agent.createSession('fix failing test')
        sessionId = session.id
        await agent.prompt({
          sessionId,
          role: 'debugger',
          text: 'The test suite of this project fails. Run `npm test`, find the bug in the source code, fix it, and run `npm test` again to confirm all tests pass.',
        })
        await Promise.race([idle, new Promise((_, rej) => setTimeout(() => rej(new Error('agent timed out')), 25 * 60_000))])
        const history: AgentPart[] = await agent.history(sessionId)
        const tools = history.filter(p => p.kind === 'tool').map(p => (p.kind === 'tool' ? `${p.tool}:${p.status}` : ''))
        const finalText = history.filter(p => p.kind === 'text' && p.role === 'assistant').map(p => (p.kind === 'text' ? p.text : '')).pop()
        console.log(`[agent] finished in ${((Date.now() - started) / 1000).toFixed(0)} s; tools: ${tools.join(', ')}`)
        console.log(`[agent] final message: ${finalText?.slice(0, 600)}`)
        console.log(`[agent] permissions asked: ${JSON.stringify(permissions)}`)
      } finally {
        await agent.stop()
        await proxy.stop()
      }

      const after = runTests(work)
      console.log(`[verify] npm test after agent: ${after.ok ? 'PASS' : 'FAIL'}\n${after.output.slice(-800)}`)
      const net = proxy.log
      console.log(`[net] ${net.length} proxied requests: ${JSON.stringify(net.map(e => `${e.method} ${e.host}:${e.port} ${e.allowed ? 'ALLOW' : 'BLOCK'}`))}`)

      expect(permissions.length).toBeGreaterThan(0) // edits/commands went through approval
      expect(net.filter(e => e.allowed && !['127.0.0.1', 'localhost', '::1'].includes(e.host))).toEqual([])
      expect(after.ok).toBe(true)

      const changes = await gitService.changes(checkpoint.commit)
      console.log(`[git] changed since checkpoint: ${JSON.stringify(changes)}`)
      expect(changes.some(c => c.path === 'src/cart.js' && c.status === 'M')).toBe(true)

      await gitService.restore(checkpoint.commit)
      expect(await gitService.changes(checkpoint.commit)).toEqual([])
      expect(runTests(work).ok).toBe(false) // reverted to the buggy state
    },
    30 * 60_000,
  )
})
