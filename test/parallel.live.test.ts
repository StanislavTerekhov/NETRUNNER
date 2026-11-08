// Live test of parallel agent jobs: two tasks at once on the real OpenCode binary and one llama-server with two
// sequence slots, each job in its own git worktree, merged into the workspace only at the end.
// Opt-in: NETRUNNER_LIVE=1 [NETRUNNER_LIVE_MODEL=<model id>] npx vitest run test/parallel.live.test.ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentTask } from '../electron/shared/ipc'
import { Database, vecExtensionPath } from '../electron/main/services/db'
import { GitService } from '../electron/main/services/git'
import { findRuntimeDir, LlamaRuntime, resolveRoles } from '../electron/main/services/llamacpp'
import { NetProxy } from '../electron/main/services/net-proxy'
import { OpenCodeService } from '../electron/main/services/opencode'
import { TaskQueue } from '../electron/main/services/tasks'

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

function runTests(cwd: string): boolean {
  try {
    execFileSync('node', ['--test'], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!LIVE)('parallel agent jobs (live)', () => {
  it(
    'two jobs run at the same time in their own worktrees; the workspace changes only on merge',
    async () => {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-par-'))
      const wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-wts-'))
      await fs.cp(path.join(root, 'test', 'fixtures', 'agent-sample'), work, { recursive: true })
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8' })
      git('init', '-q')
      git('add', '-A')
      git('commit', '-qm', 'fixture')
      expect(runTests(work)).toBe(false)

      const gitService = new GitService(() => work)
      const proxy = new NetProxy(() => 'strict-offline')
      const store = new Database(':memory:', vecExtensionPath(root, null))
      const runningAt = new Map<number, number>()
      let overlapSeen = false
      let queue: TaskQueue
      let approvals = 0

      const agent: OpenCodeService = new OpenCodeService({
        binary: path.join(root, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
        dataDir: path.join(wtRoot, 'opencode-data'),
        acquireModel: async (model, lanes) => {
          const s = await runtime.ensure('chat', model, 65536, lanes)
          runtime.pinned = model
          console.log(`[runtime] ${model}: ${s.parallel} slots × ${s.ctx} ctx, ready in ${s.readyMs} ms`)
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
          queue?.onAgentEvent(ev)
          if (ev.type === 'permission') {
            approvals++
            const t = queue.list().find(x => x.sessionId === ev.permission.sessionId)
            console.log(`[permission] #${t?.id} ${ev.permission.type}: ${ev.permission.title.slice(0, 100)} → approve once`)
            agent.respond(ev.permission.sessionId, ev.permission.id, 'once').catch(e => console.log(`[permission] reply failed: ${e}`))
          }
          if (ev.type === 'error') console.log(`[error] ${ev.sessionId}: ${ev.message}`)
        },
      })

      queue = new TaskQueue({
        store,
        agent,
        workspace: () => work,
        checkpoint: async label => (await gitService.checkpoint(label)).commit,
        searchMemory: async () => [],
        onChange: list => {
          const running = list.filter(t => t.status === 'running')
          for (const t of running) if (!runningAt.has(t.id)) runningAt.set(t.id, Date.now())
          if (running.length >= 2) overlapSeen = true
        },
        lanes: () => agent.state.lanes,
        worktrees: {
          available: () => gitService.isRepo(),
          create: async (jobId, label) => {
            const base = (await gitService.checkpoint(label)).commit
            const dir = path.join(wtRoot, jobId)
            await gitService.addWorktree(dir, base)
            return { path: dir, base }
          },
          changes: (base, dir) => gitService.worktreeChanges(base, dir),
          merge: async (base, dir, label) => ({ checkpoint: (await gitService.checkpoint(label)).commit, ...(await gitService.mergeWorktree(base, dir)) }),
          remove: dir => gitService.removeWorktree(dir),
        },
      })

      const started = Date.now()
      let list: AgentTask[] = []
      try {
        const model = process.env.NETRUNNER_LIVE_MODEL ?? resolveRoles(await runtime.catalog.list(), { defaultModel: null, agentModel: null, embeddingModel: null }).agent
        if (!model) throw new Error('no agent model installed')
        const state = await agent.start(work, model, 2)
        console.log(`[agent] OpenCode ${state.version}, lanes ${state.lanes}, engine up after ${((Date.now() - started) / 1000).toFixed(0)} s`)
        queue.onAgentEvent({ type: 'engine', state })

        const fix = queue.enqueue({
          role: 'debugger',
          prompt: 'The test suite of this project fails. Run `npm test`, find the bug in src/cart.js, fix it, and run `npm test` again to confirm all tests pass. Do not create other files.',
          useMemory: false,
        })
        const money = queue.enqueue({
          role: 'coder',
          prompt:
            "Create the file src/money.js exporting `formatMoney(amount)` that returns the amount with two decimals and a '$' prefix, e.g. formatMoney(3.5) === '$3.50' and formatMoney(12) === '$12.00'. Use an ES module export like src/cart.js does. Do not change any other file.",
          useMemory: false,
        })
        const deadline = Date.now() + 40 * 60_000
        while (Date.now() < deadline) {
          list = queue.list()
          const done = [fix, money].every(t => {
            const cur = list.find(x => x.id === t.id)
            return cur && !['queued', 'running'].includes(cur.status) && cur.worktree?.state !== 'active'
          })
          if (done) break
          await new Promise(r => setTimeout(r, 2000))
        }
        console.log(`[queue] finished after ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(list.map(t => `#${t.id} ${t.role} ${t.status} job=${t.worktree?.state} changes=${t.worktree?.changes}`))}`)
        const starts = [fix.id, money.id].map(id => runningAt.get(id) ?? 0)
        console.log(`[queue] start offset between the jobs: ${Math.abs(starts[0] - starts[1])} ms; both running at once: ${overlapSeen}; approvals: ${approvals}`)

        // Before merging: the workspace is untouched.
        expect(runTests(work)).toBe(false)
        expect(await fs.stat(path.join(work, 'src', 'money.js')).catch(() => null)).toBeNull()
        expect(list.filter(t => t.status === 'done')).toHaveLength(2)
        expect(overlapSeen).toBe(true)

        for (const t of [fix, money]) {
          const files = await queue.jobChanges(t.jobId)
          console.log(`[merge] ${t.jobId}: ${files.map(f => `${f.status} ${f.path}`).join(', ')}`)
          const job = await queue.mergeJob(t.jobId)
          console.log(`[merge] ${t.jobId}: ${job.state}, conflicts ${JSON.stringify(job.conflicts)}`)
          expect(job.conflicts).toEqual([])
        }
      } finally {
        await agent.stop()
        await proxy.stop()
      }

      expect(runTests(work)).toBe(true)
      const { formatMoney } = (await import(pathToFileURL(path.join(work, 'src', 'money.js')).href)) as { formatMoney: (n: number) => string }
      console.log(`[verify] formatMoney(3.5) = ${formatMoney(3.5)}, formatMoney(12) = ${formatMoney(12)}`)
      expect(formatMoney(3.5)).toBe('$3.50')
      expect(formatMoney(12)).toBe('$12.00')
      const worktrees = git('worktree', 'list')
      console.log(`[git] worktrees after merge:\n${worktrees}`)
      expect(worktrees.trim().split('\n')).toHaveLength(1)
      const net = proxy.log
      console.log(`[net] ${net.length} proxied requests: ${JSON.stringify(net.map(e => `${e.method} ${e.host}:${e.port} ${e.allowed ? 'ALLOW' : 'BLOCK'}`))}`)
      expect(net.filter(e => e.allowed && !['127.0.0.1', 'localhost', '::1'].includes(e.host))).toEqual([])
    },
    45 * 60_000,
  )
})
