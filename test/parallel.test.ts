import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentPart, AgentRole, AgentTask, ChangedFile } from '../electron/shared/ipc'
import { Database, vecExtensionPath } from '../electron/main/services/db'
import { GitService } from '../electron/main/services/git'
import { LlamaRuntime, LMSTUDIO_PREFIX, ModelCatalog, resolveRoles, serverArgs, type CatalogEntry } from '../electron/main/services/llamacpp'
import { findLmStudioModelsDir } from '../electron/main/services/lmstudio'
import { normalizeLayout, SettingsStore } from '../electron/main/services/settings'
import { TaskQueue, type AgentPort, type WorktreePort } from '../electron/main/services/tasks'

const VEC = vecExtensionPath(path.resolve(__dirname, '..'), null)
const temps: string[] = []
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Smallest valid GGUF v3 header: no tensors, string metadata only. */
function writeGguf(file: string, meta: Record<string, string>): void {
  const parts: Buffer[] = []
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const u64 = (n: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(n))
    return b
  }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(meta).length))
  for (const [k, v] of Object.entries(meta)) parts.push(str(k), u32(8), str(v))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(parts))
}

describe('LM Studio as a model source', () => {
  it('finds the models folder: settings downloadsFolder, home pointer, defaults, manual override', () => {
    const home = tmp('nr-home-')
    expect(findLmStudioModelsDir(home, null)).toBeNull()
    fs.mkdirSync(path.join(home, '.lmstudio', 'models'), { recursive: true })
    expect(findLmStudioModelsDir(home, null)).toBe(path.join(home, '.lmstudio', 'models'))

    const custom = path.join(home, 'D-drive', 'llms')
    fs.mkdirSync(custom, { recursive: true })
    fs.writeFileSync(path.join(home, '.lmstudio', 'settings.json'), JSON.stringify({ downloadsFolder: custom }))
    expect(findLmStudioModelsDir(home, null)).toBe(custom)

    const moved = path.join(home, 'elsewhere')
    fs.mkdirSync(path.join(moved, 'models'), { recursive: true })
    fs.writeFileSync(path.join(home, '.lmstudio-home-pointer'), moved)
    expect(findLmStudioModelsDir(home, null)).toBe(path.join(moved, 'models'))

    expect(findLmStudioModelsDir(home, path.join(home, 'missing'))).toBeNull()
    expect(findLmStudioModelsDir(home, custom)).toBe(custom)
  })

  it('lists LM Studio models next to NETRUNNER models, with prefixed ids, and never lists one folder twice', async () => {
    const own = tmp('nr-models-')
    const lm = tmp('nr-lms-')
    writeGguf(path.join(own, 'Qwen', 'a-Q4_K_M.gguf'), { 'general.architecture': 'qwen3', 'tokenizer.chat_template': '{{ tools }}' })
    writeGguf(path.join(lm, 'lmstudio-community', 'Repo-GGUF', 'b-Q8_0.gguf'), { 'general.architecture': 'qwen3' })
    const catalog = new ModelCatalog(own, () => [{ source: 'lmstudio', dir: lm, prefix: LMSTUDIO_PREFIX }])
    const list = await catalog.list()
    expect(list.map(e => [e.id, e.source])).toEqual([
      ['Qwen/a-Q4_K_M.gguf', 'netrunner'],
      ['lmstudio:lmstudio-community/Repo-GGUF/b-Q8_0.gguf', 'lmstudio'],
    ])
    expect((await catalog.get('lmstudio:lmstudio-community/Repo-GGUF/b-Q8_0.gguf')).files[0]).toBe(path.join(lm, 'lmstudio-community', 'Repo-GGUF', 'b-Q8_0.gguf'))

    const same = new ModelCatalog(own, () => [{ source: 'lmstudio', dir: own, prefix: LMSTUDIO_PREFIX }])
    expect((await same.list()).map(e => e.id)).toEqual(['Qwen/a-Q4_K_M.gguf'])
  })

  it('refuses to delete a model that belongs to LM Studio', async () => {
    const own = tmp('nr-models-')
    const lm = tmp('nr-lms-')
    const file = path.join(lm, 'pub', 'repo', 'c-Q4_0.gguf')
    writeGguf(file, { 'general.architecture': 'llama' })
    const runtime = new LlamaRuntime({
      binaryDir: () => null,
      modelsDir: own,
      extraRoots: () => [{ source: 'lmstudio', dir: lm, prefix: LMSTUDIO_PREFIX }],
      getMode: () => 'strict-offline',
      onDownload: () => undefined,
    })
    await expect(runtime.remove('lmstudio:pub/repo/c-Q4_0.gguf')).rejects.toThrow(/belongs to LM Studio/)
    expect(fs.existsSync(file)).toBe(true)
    expect((await runtime.list())[0]).toMatchObject({ source: 'lmstudio', label: 'c-Q4_0' })
  })

  it('shows Qwen models under their real name', async () => {
    const own = tmp('nr-models-')
    writeGguf(path.join(own, 'Qwen', 'Qwen3-Coder-Next-GGUF', 'Qwen3-Coder-Next-Q4_K_M.gguf'), { 'general.architecture': 'qwen3next', 'tokenizer.chat_template': '{{ tools }}' })
    const runtime = new LlamaRuntime({ binaryDir: () => null, modelsDir: own, getMode: () => 'strict-offline', onDownload: () => undefined })
    expect((await runtime.list())[0]).toMatchObject({ label: 'Qwen3-Coder-Next-Q4_K_M', name: 'Qwen/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M.gguf' })
    // Role matching still sees the real name.
    expect(resolveRoles(await runtime.catalog.list(), { defaultModel: null, agentModel: null, embeddingModel: null }).agent).toBe('Qwen/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M.gguf')
  })
})

describe('settings for sources, parallel agents and layouts', () => {
  it('keeps valid values, drops malformed ones', async () => {
    const dir = tmp('nr-settings-')
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        agentLanes: 9,
        lmStudioDir: 'relative/path',
        activeLayout: 'bad id!',
        layouts: [{ id: 'u1', name: ' Mine ', explorer: false, terminal: 'bottom', chat: true }, { id: 'x' }, { id: 'u2', name: 'Two', terminal: 'sideways' }],
      }),
    )
    const s = new SettingsStore(dir)
    const loaded = await s.load()
    expect(loaded).toMatchObject({ agentLanes: 1, lmStudioDir: null, activeLayout: 'classic' })
    expect(loaded.layouts).toEqual([
      { id: 'u1', name: 'Mine', explorer: false, terminal: 'bottom', chat: true },
      { id: 'u2', name: 'Two', explorer: true, terminal: 'section', chat: false },
    ])
    await expect(s.setAgentLanes(5)).rejects.toThrow(/1–4/)
    expect((await s.setAgentLanes(3)).agentLanes).toBe(3)
    await expect(s.setLayouts([{ id: 'u1' }], 'u1')).rejects.toThrow(/Invalid layout/)
    expect((await s.setLayouts([{ id: 'u3', name: 'Three', explorer: true, terminal: 'right', chat: false }], 'u3')).activeLayout).toBe('u3')
    expect((await new SettingsStore(dir).load()).agentLanes).toBe(3)
    expect(normalizeLayout({ id: 'a', name: 'x'.repeat(80) })?.name).toHaveLength(40)
  })

  it('stores fast mode per model and drops malformed entries', async () => {
    const dir = tmp('nr-settings-')
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fastExperts: { 'a/m.gguf': 8, 'qwen3:8b': 8, 'b.gguf': 0, 'c.gguf': 2.5 } }))
    const s = new SettingsStore(dir)
    expect((await s.load()).fastExperts).toEqual({ 'a/m.gguf': 8 })
    await expect(s.setFastExperts('a/m.gguf', 0)).rejects.toThrow(/1–256/)
    expect((await s.setFastExperts('d.gguf', 6)).fastExperts).toEqual({ 'a/m.gguf': 8, 'd.gguf': 6 })
    expect((await s.setFastExperts('a/m.gguf', null)).fastExperts).toEqual({ 'd.gguf': 6 })
    expect((await new SettingsStore(dir).load()).fastExperts).toEqual({ 'd.gguf': 6 })
  })

  it('stores VRAM saver and idle-unload times, with safe defaults (NSC-ME)', async () => {
    const dir = tmp('nr-settings-')
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ vramSaver: ['a/m.gguf', 'a/m.gguf', 'qwen3:8b', 5], idleUnload: { smallMinutes: 7, largeMinutes: 30 } }))
    const s = new SettingsStore(dir)
    const loaded = await s.load()
    expect(loaded.vramSaver).toEqual(['a/m.gguf'])
    // An unknown time falls back to the default (small 10 min); a known one is kept.
    expect(loaded.idleUnload).toEqual({ smallMinutes: 10, largeMinutes: 30 })
    expect((await s.setVramSaver('b.gguf', true)).vramSaver).toEqual(['a/m.gguf', 'b.gguf'])
    expect((await s.setVramSaver('a/m.gguf', false)).vramSaver).toEqual(['b.gguf'])
    await expect(s.setIdleUnload(7, 0)).rejects.toThrow(/minutes/)
    expect((await s.setIdleUnload(5, 60)).idleUnload).toEqual({ smallMinutes: 5, largeMinutes: 60 })
    expect(await new SettingsStore(dir).load()).toMatchObject({ vramSaver: ['b.gguf'], idleUnload: { smallMinutes: 5, largeMinutes: 60 } })
    // A fresh install: small models after 10 minutes, large ones never.
    expect((await new SettingsStore(tmp('nr-settings-')).load()).idleUnload).toEqual({ smallMinutes: 10, largeMinutes: 0 })
  })
})

describe('llama-server slots for parallel agents', () => {
  const entry = { id: 'm.gguf', source: 'netrunner', name: 'm', files: ['C:\\m.gguf'], sizeBytes: 1, modifiedAt: '', kind: 'chat', arch: 'qwen3next', sizeLabel: null, quant: null, contextLength: 262144, expertCount: 512, mmproj: null, capabilities: [], license: null, mtp: false, blocks: 48 } as CatalogEntry
  it('gives every sequence its own context: -c = ctx × slots', () => {
    const one = serverArgs(entry, 1, 'k', 65536)
    expect(one.slice(one.indexOf('-c'), one.indexOf('-c') + 4)).toEqual(['-c', '65536', '-np', '1'])
    const three = serverArgs(entry, 1, 'k', 65536, 3)
    expect(three.slice(three.indexOf('-c'), three.indexOf('-c') + 4)).toEqual(['-c', '196608', '-np', '3'])
  })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function repo(): string {
  const dir = tmp('nr-repo-')
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n')
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'delete me\n')
  fs.writeFileSync(path.join(dir, 'clash.txt'), 'base\n')
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

describe('git worktrees for parallel jobs', () => {
  it('isolates a job, merges three ways into the workspace and never touches the workspace node_modules', async () => {
    const root = repo()
    const svc = new GitService(() => root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'bee (uncommitted)\n') // uncommitted work travels with the checkpoint
    const base = (await svc.checkpoint('job j1')).commit
    const wt = path.join(tmp('nr-wts-'), 'j1')
    await svc.addWorktree(wt, base)
    expect(fs.readFileSync(path.join(wt, 'b.txt'), 'utf8')).toBe('bee (uncommitted)\n')
    expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(wt, 'node_modules', 'dep', 'index.js'))).toBe(true)

    // The agent's edits in the worktree.
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN (agent)\n')
    fs.writeFileSync(path.join(wt, 'new.txt'), 'created by the agent\n')
    fs.rmSync(path.join(wt, 'gone.txt'))
    fs.writeFileSync(path.join(wt, 'clash.txt'), 'agent\n')
    // Meanwhile the operator keeps working in the workspace.
    fs.writeFileSync(path.join(root, 'a.txt'), 'ONE (operator)\ntwo\nthree\nfour\nfive\nsix\nseven\n')
    fs.writeFileSync(path.join(root, 'clash.txt'), 'operator\n')

    const changes: ChangedFile[] = await svc.worktreeChanges(base, wt)
    expect(changes.map(c => `${c.status} ${c.path}`).sort()).toEqual(['A new.txt', 'D gone.txt', 'M a.txt', 'M clash.txt'])
    // Nothing reached the workspace yet.
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)

    const res = await svc.mergeWorktree(base, wt)
    expect(res.applied.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    expect(res.conflicts).toEqual(['clash.txt'])
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('ONE (operator)\ntwo\nthree\nfour\nfive\nsix\nSEVEN (agent)\n')
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('created by the agent\n')
    expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false)
    const clash = fs.readFileSync(path.join(root, 'clash.txt'), 'utf8')
    expect(clash).toContain('<<<<<<< workspace')
    expect(clash).toContain('>>>>>>> agent')

    await svc.removeWorktree(wt)
    expect(fs.existsSync(wt)).toBe(false)
    expect(fs.readFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(git(root, 'worktree', 'list')).not.toContain('j1')
  })
})

/** Agent engine double that keeps every session busy for a while, to observe concurrency. */
class SlowAgent implements AgentPort {
  state = { status: 'running' }
  emit: (e: AgentEvent) => void = () => undefined
  sessions = new Map<string, { role: AgentRole; dir: string | undefined }>()
  busy = 0
  maxBusy = 0
  order: string[] = []
  private n = 0
  async createSession(_title: string, directory?: string) {
    const id = `s${++this.n}`
    this.sessions.set(id, { role: 'coder', dir: directory })
    return { id }
  }
  async prompt(req: { sessionId: string; text: string; role: AgentRole }) {
    this.sessions.get(req.sessionId)!.role = req.role
    this.order.push(`start ${req.role}`)
    this.busy++
    this.maxBusy = Math.max(this.maxBusy, this.busy)
    this.emit({ type: 'status', sessionId: req.sessionId, busy: true, detail: null })
    setTimeout(() => {
      this.busy--
      this.order.push(`end ${req.role}`)
      this.emit({ type: 'status', sessionId: req.sessionId, busy: false, detail: null })
    }, 40)
  }
  async history(sessionId: string): Promise<AgentPart[]> {
    return [{ kind: 'text', id: 'p', messageId: 'm', role: 'assistant', text: `${this.sessions.get(sessionId)?.role} done` }]
  }
  async abort() {}
}

class FakeWorktrees implements WorktreePort {
  created: string[] = []
  removed: string[] = []
  merged: string[] = []
  changed = new Map<string, number>()
  async available() {
    return true
  }
  async create(jobId: string) {
    this.created.push(jobId)
    return { path: `C:\\wt\\${jobId}`, base: 'b'.repeat(40) }
  }
  async changes(_base: string, p: string): Promise<ChangedFile[]> {
    return Array.from({ length: this.changed.get(p) ?? 1 }, (_, i) => ({ status: 'M' as const, path: `f${i}` }))
  }
  async merge(_base: string, p: string) {
    this.merged.push(p)
    return { checkpoint: 'c'.repeat(40), applied: ['f0'], conflicts: [] }
  }
  async remove(p: string) {
    this.removed.push(p)
  }
}

function parallelSetup(lanes: number) {
  const store = new Database(':memory:', VEC)
  const agent = new SlowAgent()
  const worktrees = new FakeWorktrees()
  const inPlace: string[] = []
  const queue = new TaskQueue({
    store,
    agent,
    workspace: () => 'C:\\ws',
    checkpoint: async label => (inPlace.push(label), 'a'.repeat(40)),
    searchMemory: async () => [],
    onChange: () => undefined,
    lanes: () => lanes,
    worktrees,
  })
  agent.emit = e => queue.onAgentEvent(e)
  const settled = () =>
    new Promise<AgentTask[]>(resolve => {
      const check = () => {
        const list = queue.list()
        const jobsSettled = list.every(t => !t.worktree || t.worktree.state !== 'active')
        if (jobsSettled && list.every(t => !['queued', 'running'].includes(t.status))) resolve(list)
        else setTimeout(check, 10)
      }
      check()
    })
  return { agent, worktrees, queue, inPlace, settled }
}

describe('TaskQueue with parallel lanes', () => {
  it('runs editing jobs side by side in their own worktrees; pipeline steps stay in order inside their job', async () => {
    const { agent, worktrees, queue, inPlace, settled } = parallelSetup(3)
    const [first] = queue.enqueuePipeline('feature A', false)
    const solo = queue.enqueue({ role: 'coder', prompt: 'fix B', useMemory: false })
    const review = queue.enqueue({ role: 'reviewer', prompt: 'review C', useMemory: false })
    const list = await settled()

    expect(list.every(t => t.status === 'done')).toBe(true)
    expect(agent.maxBusy).toBe(3)
    // One worktree per editing job; the read-only reviewer ran in the workspace (with a checkpoint).
    expect(worktrees.created.sort()).toEqual([first.jobId, solo.jobId].sort())
    expect(list.find(t => t.id === review.id)?.worktree).toBeNull()
    expect(inPlace).toHaveLength(1)
    const dirs = [...agent.sessions.values()]
    expect(dirs.filter(s => s.dir === `C:\\wt\\${first.jobId}`)).toHaveLength(4)
    // Inside the pipeline job: strictly one step after another.
    const pipelineOrder = agent.order.filter(e => /architect|debugger/.test(e))
    expect(pipelineOrder).toEqual(['start architect', 'end architect', 'start debugger', 'end debugger'])
    expect(list.filter(t => t.jobId === first.jobId).every(t => t.worktree?.state === 'ready')).toBe(true)
  })

  it('merges or discards a finished job, removes worktrees without changes', async () => {
    const { worktrees, queue, settled } = parallelSetup(2)
    const a = queue.enqueue({ role: 'coder', prompt: 'a', useMemory: false })
    const b = queue.enqueue({ role: 'coder', prompt: 'b', useMemory: false })
    worktrees.changed.set(`C:\\wt\\j${b.id + 1}`, 0)
    const c = queue.enqueue({ role: 'debugger', prompt: 'c', useMemory: false })
    await settled()
    expect(queue.list().find(t => t.id === c.id)?.worktree).toMatchObject({ state: 'empty', changes: 0 })
    expect(worktrees.removed).toEqual([`C:\\wt\\${c.jobId}`])

    const merged = await queue.mergeJob(a.jobId)
    expect(merged).toMatchObject({ state: 'merged', mergeCheckpoint: 'c'.repeat(40), conflicts: [] })
    await expect(queue.mergeJob(a.jobId)).rejects.toThrow(/merged/)
    expect((await queue.discardJob(b.jobId)).state).toBe('discarded')
    expect(worktrees.removed).toContain(`C:\\wt\\${b.jobId}`)
  })

  it('with one lane keeps the old behaviour: sequential, in the workspace, checkpoint per task', async () => {
    const { agent, worktrees, queue, inPlace, settled } = parallelSetup(1)
    queue.enqueue({ role: 'coder', prompt: 'a', useMemory: false })
    queue.enqueue({ role: 'coder', prompt: 'b', useMemory: false })
    await settled()
    expect(agent.maxBusy).toBe(1)
    expect(worktrees.created).toEqual([])
    expect(inPlace).toHaveLength(2)
  })
})
