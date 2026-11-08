import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentPart, AgentRole, AgentTask } from '../electron/shared/ipc'
import { Database } from '../electron/main/services/db'
import { chunkText, formatMemoryContext, MemoryService, QUERY_INSTRUCTION } from '../electron/main/services/memory'
import { PIPELINE, TaskQueue, type AgentPort } from '../electron/main/services/tasks'

const VEC = path.resolve(import.meta.dirname, '..', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')

/** Deterministic stand-in for an embedding model: hashed bag of words, L2-normalised. */
function fakeEmbed(text: string, dims = 64): number[] {
  const v = new Array(dims).fill(0)
  for (const w of text.replace(QUERY_INSTRUCTION, '').toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 0
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    v[h % dims] += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map(x => x / n)
}

describe('chunkText', () => {
  it('splits into overlapping windows with 1-based line numbers', () => {
    const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkText(text, 60, 10)
    expect(chunks.map(c => [c.startLine, c.endLine])).toEqual([[1, 60], [51, 110], [101, 130]])
    expect(chunks[1].content.split('\n')[0]).toBe('line 51')
  })
  it('skips blank input', () => {
    expect(chunkText('\n\n  \n')).toEqual([])
  })
})

describe('MemoryService', () => {
  let ws: string
  let calls = 0
  const store = new Database(':memory:', VEC)
  let model = 'fake-embed'
  const memory = new MemoryService(
    store,
    async (_m, inputs) => {
      calls += inputs.length
      return inputs.map(t => fakeEmbed(t))
    },
    () => model,
  )

  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-mem-'))
    await fs.mkdir(path.join(ws, 'src'))
    await fs.mkdir(path.join(ws, 'node_modules', 'dep'), { recursive: true })
    await fs.writeFile(path.join(ws, 'src', 'cart.js'), 'export function cartTotal(items) {\n  // shopping cart total price quantity discount\n}\n')
    await fs.writeFile(path.join(ws, 'src', 'auth.ts'), 'export function login(user, password) {\n  // authentication session token password hashing\n}\n')
    await fs.writeFile(path.join(ws, 'node_modules', 'dep', 'index.js'), 'shopping cart total') // must be skipped
    await fs.writeFile(path.join(ws, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  })
  afterAll(async () => {
    await fs.rm(ws, { recursive: true, force: true })
  })

  it('indexes source files only and finds the semantically closest chunk', async () => {
    const p = await memory.index(ws)
    expect(p).toMatchObject({ phase: 'done', filesTotal: 2, filesDone: 2, chunksEmbedded: 2, error: null })
    expect(await memory.status(ws)).toMatchObject({ files: 2, chunks: 2, model: 'fake-embed', dims: 64 })
    const hits = await memory.search(ws, 'where is the shopping cart price total computed', 2)
    expect(hits[0].path).toBe('src/cart.js')
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect((await memory.search(ws, 'password hashing for login', 1))[0].path).toBe('src/auth.ts')
  })

  it('re-embeds only changed files and drops deleted ones', async () => {
    calls = 0
    let p = await memory.index(ws)
    expect(calls).toBe(0)
    await fs.writeFile(path.join(ws, 'src', 'auth.ts'), 'export function logout() {\n  // end session, revoke token\n}\n')
    await fs.rm(path.join(ws, 'src', 'cart.js'))
    p = await memory.index(ws)
    expect(calls).toBe(1)
    expect(p.filesRemoved).toBe(1)
    expect(await memory.status(ws)).toMatchObject({ files: 1, chunks: 1 })
    const hits = await memory.search(ws, 'shopping cart', 5)
    expect(hits.map(h => h.path)).toEqual(['src/auth.ts']) // cart vectors are gone, not just hidden
  })

  it('isolates workspaces and resets the index when the embedding model changes', async () => {
    expect(await memory.search(path.join(ws, 'other'), 'token', 5)).toEqual([])
    model = 'another-model'
    await memory.index(ws)
    expect((await memory.status(ws)).model).toBe('another-model')
    expect((await memory.status(ws)).chunks).toBe(1)
  })

  it('formats hits as a bounded prompt context', () => {
    const ctx = formatMemoryContext([{ path: 'a.ts', startLine: 1, endLine: 3, content: 'x'.repeat(50), score: 0.9 }], 200)
    expect(ctx).toContain('a.ts (lines 1-3, similarity 0.90)')
    expect(formatMemoryContext([{ path: 'a.ts', startLine: 1, endLine: 3, content: 'x'.repeat(500), score: 0.9 }], 200)).not.toContain('a.ts')
  })
})

/** Agent engine double: each prompt finishes after a tick with a scripted answer or error. */
class FakeAgent implements AgentPort {
  state = { status: 'running' }
  prompts: { role: AgentRole; text: string }[] = []
  emit: (e: AgentEvent) => void = () => undefined
  answers = new Map<string, string>()
  fail = new Set<AgentRole>()
  private n = 0

  async createSession() {
    return { id: `s${++this.n}` }
  }
  async prompt(req: { sessionId: string; text: string; role: AgentRole }) {
    this.prompts.push({ role: req.role, text: req.text })
    this.answers.set(req.sessionId, `${req.role} says done`)
    setTimeout(() => {
      this.emit({ type: 'status', sessionId: req.sessionId, busy: true, detail: null })
      if (this.fail.has(req.role)) this.emit({ type: 'error', sessionId: req.sessionId, message: `${req.role} crashed` })
      this.emit({ type: 'status', sessionId: req.sessionId, busy: false, detail: null })
    }, 5)
  }
  async history(sessionId: string): Promise<AgentPart[]> {
    return [{ kind: 'text', id: 'p', messageId: 'm', role: 'assistant', text: this.answers.get(sessionId) ?? '' }]
  }
  async abort() {}
}

function setup() {
  const store = new Database(':memory:', VEC)
  const agent = new FakeAgent()
  const changes: AgentTask[][] = []
  const checkpoints: string[] = []
  const queue = new TaskQueue({
    store,
    agent,
    workspace: () => 'C:\\ws',
    checkpoint: async label => {
      checkpoints.push(label)
      return 'c'.repeat(40)
    },
    searchMemory: async q => [{ path: 'src/x.ts', startLine: 1, endLine: 2, content: `code for ${q}`, score: 0.8 }],
    onChange: t => changes.push(t),
  })
  agent.emit = e => queue.onAgentEvent(e)
  const settled = () =>
    new Promise<AgentTask[]>(resolve => {
      const check = () => {
        const list = queue.list()
        if (list.every(t => !['queued', 'running'].includes(t.status))) resolve(list)
        else setTimeout(check, 10)
      }
      check()
    })
  return { store, agent, queue, changes, checkpoints, settled }
}

describe('TaskQueue', () => {
  it('runs a pipeline sequentially, passing earlier results and memory as context', async () => {
    const { agent, queue, checkpoints, settled } = setup()
    queue.enqueuePipeline('add a logout button', true)
    const list = await settled()
    expect(agent.prompts.map(p => p.role)).toEqual(PIPELINE.map(s => s.role))
    expect(list.every(t => t.status === 'done')).toBe(true)
    expect(agent.prompts[0].text).toContain('Goal: add a logout button')
    expect(agent.prompts[0].text).toContain('Relevant code from the project memory')
    expect(agent.prompts[2].text).toContain('Result of step 1 (ARCHITECT)')
    expect(agent.prompts[2].text).toContain('coder says done')
    expect(checkpoints).toHaveLength(4)
    expect(list.find(t => t.role === 'reviewer')?.result).toBe('reviewer says done')
  })

  it('stops the rest of a pipeline when a step fails, and retry re-queues it', async () => {
    const { agent, queue, settled } = setup()
    agent.fail.add('coder')
    queue.enqueuePipeline('refactor', false)
    let list = await settled()
    const byRole = Object.fromEntries(list.map(t => [t.role, t]))
    expect(byRole.architect.status).toBe('done')
    expect(byRole.coder).toMatchObject({ status: 'failed', error: 'coder crashed' })
    expect(byRole.debugger).toMatchObject({ status: 'cancelled', error: 'previous step (coder) failed' })
    expect(agent.prompts.map(p => p.role)).toEqual(['architect', 'coder'])

    agent.fail.clear()
    queue.retry(byRole.coder.id)
    list = await settled()
    expect(list[0]).toMatchObject({ role: 'coder', status: 'done', pipelineId: null })
  })

  it('cancels queued tasks and waits for a running engine', async () => {
    const { agent, queue, settled } = setup()
    agent.state.status = 'stopped'
    const a = queue.enqueue({ role: 'operator', prompt: 'npm run build', useMemory: false })
    const b = queue.enqueue({ role: 'reviewer', prompt: 'review', useMemory: false })
    expect(queue.list().map(t => t.status)).toEqual(['queued', 'queued'])
    await queue.cancel(b.id)
    agent.state.status = 'running'
    queue.onAgentEvent({ type: 'engine', state: { status: 'running', url: null, workspace: null, model: null, version: null, error: null, lanes: 1 } })
    const list = await settled()
    expect(list.find(t => t.id === a.id)?.status).toBe('done')
    expect(list.find(t => t.id === b.id)?.status).toBe('cancelled')
    expect(agent.prompts.map(p => p.text)).toEqual(['npm run build'])
  })

  it('marks tasks left running by a previous app run as interrupted', () => {
    const store = new Database(':memory:', VEC)
    store.db.prepare(`INSERT INTO tasks (workspace, role, prompt, status, created_at) VALUES ('C:\\ws', 'coder', 'x', 'running', 't')`).run()
    const queue = new TaskQueue({ store, agent: new FakeAgent(), workspace: () => 'C:\\ws', checkpoint: async () => null, searchMemory: async () => [], onChange: () => undefined })
    expect(queue.list()[0].status).toBe('interrupted')
  })

  it('rejects unknown roles and empty prompts', () => {
    const { queue } = setup()
    expect(() => queue.enqueue({ role: 'hacker' as AgentRole, prompt: 'x', useMemory: false })).toThrow(/Unknown role/)
    expect(() => queue.enqueue({ role: 'coder', prompt: '  ', useMemory: false })).toThrow(/Empty task/)
  })
})
