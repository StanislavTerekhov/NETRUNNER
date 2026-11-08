import crypto from 'node:crypto'
import type { AgentEvent, AgentJob, AgentPart, AgentRole, AgentTask, ChangedFile, EnqueueRequest, MemoryHit } from '../../shared/ipc'
import type { Database } from './db'
import { formatMemoryContext } from './memory'

const ROLES: AgentRole[] = ['architect', 'coder', 'debugger', 'reviewer', 'operator']
/** Roles that cannot edit files (see ROLE_PROMPTS in opencode.ts); alone they may run in the workspace itself. */
const READ_ONLY: AgentRole[] = ['architect', 'reviewer']

/** The default multi-agent pipeline: plan → implement → test/fix → review. */
export const PIPELINE: { role: AgentRole; instruction: string }[] = [
  { role: 'architect', instruction: 'Analyze the codebase for this goal and write a concrete implementation plan: files to change, steps, risks. Do not modify files.' },
  { role: 'coder', instruction: 'Implement the plan from the previous step. Keep edits minimal and consistent with the existing code.' },
  { role: 'debugger', instruction: 'Run the project tests. If anything fails, find the root cause and fix it, then re-run the tests. Report the real test output.' },
  { role: 'reviewer', instruction: 'Review the changes made for this goal for bugs, security issues and regressions. Cite files and lines. Do not modify files.' },
]

/**
 * Verified facts for the next pipeline step: the real diff, then per earlier step the files it edited and the
 * commands it ran with their actual output (tail) — taken from the tool log, not from the agent's summary.
 */
export function formatVerifiedFacts(diff: string, steps: { task: AgentTask; parts: AgentPart[] }[], maxChars = 16000): string {
  const out: string[] = []
  out.push(diff.trim() ? `### Changes since the pipeline started (git diff)\n\`\`\`diff\n${diff.trim()}\n\`\`\`` : '### Changes since the pipeline started\nNo file has changed.')
  for (const { task, parts } of steps) {
    const tools = parts.filter((p): p is Extract<AgentPart, { kind: 'tool' }> => p.kind === 'tool')
    const edited = [...new Set(tools.map(p => p.input.filePath ?? p.input.path).filter((f): f is string => typeof f === 'string'))]
    const commands = tools.filter(p => p.tool === 'bash' && typeof p.input.command === 'string')
    const lines = [`### Step ${task.pipelineStep! + 1} (${task.role.toUpperCase()}), status ${task.status}`]
    lines.push(edited.length ? `Files it touched: ${edited.join(', ')}` : 'Files it touched: none')
    if (!commands.length) lines.push('Commands it ran: none')
    for (const c of commands) {
      const output = (c.error ?? c.output).trim()
      lines.push(`Command: \`${String(c.input.command).slice(0, 300)}\` → ${c.status}${output ? `\n\`\`\`\n${output.slice(-1500)}\n\`\`\`` : ' (no output)'}`)
    }
    out.push(lines.join('\n'))
  }
  const text = out.join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (facts cut at ${maxChars} characters)` : text
}

/** What the queue needs from the agent engine (OpenCodeService implements it). */
export interface AgentPort {
  readonly state: { status: string }
  /** `directory`: run the session in that folder (a worktree) instead of the workspace. */
  createSession(title: string, directory?: string): Promise<{ id: string }>
  prompt(req: { sessionId: string; text: string; role: AgentRole }): Promise<void>
  history(sessionId: string): Promise<AgentPart[]>
  abort(sessionId: string): Promise<void>
}

/** Git worktrees for jobs that run in parallel (index.ts implements it with GitService). */
export interface WorktreePort {
  /** Whether worktrees can be used (the workspace is a git repository). */
  available(): Promise<boolean>
  /** Checkpoint the workspace and check it out into a new worktree for the job. */
  create(jobId: string, label: string): Promise<{ path: string; base: string }>
  changes(base: string, path: string): Promise<ChangedFile[]>
  /** Checkpoint the workspace, then merge the worktree's changes into it. */
  merge(base: string, path: string, label: string): Promise<{ checkpoint: string | null; applied: string[]; conflicts: string[] }>
  remove(path: string): Promise<void>
}

interface Deps {
  store: Database
  agent: AgentPort
  workspace: () => string | null
  checkpoint: (label: string) => Promise<string | null>
  searchMemory: (query: string) => Promise<MemoryHit[]>
  onChange: (tasks: AgentTask[]) => void
  /** Jobs allowed to run at the same time (1 = strictly sequential, in the workspace). */
  lanes?: () => number
  worktrees?: WorktreePort
  /**
   * Facts NETRUNNER gathers itself for a pipeline step (real diff since the pipeline started, commands the earlier
   * steps ran and their output) — so a step does not rely only on the previous agent's own summary.
   */
  verifiedFacts?: (t: AgentTask, previous: AgentTask[]) => Promise<string>
}

interface Row {
  id: number
  role: string
  prompt: string
  status: string
  use_memory: number
  pipeline_id: string | null
  pipeline_step: number | null
  session_id: string | null
  checkpoint: string | null
  result: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  job_id: string | null
}

interface JobRow {
  id: string
  path: string
  base: string
  state: AgentJob['state']
  changes: number | null
  merge_checkpoint: string | null
  conflicts: string | null
}

const toJob = (j: JobRow): AgentJob => ({
  id: j.id,
  path: j.path,
  base: j.base,
  state: j.state,
  changes: j.changes === null ? null : Number(j.changes),
  mergeCheckpoint: j.merge_checkpoint,
  conflicts: j.conflicts ? (JSON.parse(j.conflicts) as string[]) : [],
})

const jobOf = (r: Row) => r.job_id ?? r.pipeline_id ?? `j${Number(r.id)}`

const toTask = (r: Row, job: AgentJob | null = null): AgentTask => ({
  id: Number(r.id),
  role: r.role as AgentRole,
  prompt: r.prompt,
  status: r.status as AgentTask['status'],
  useMemory: !!r.use_memory,
  pipelineId: r.pipeline_id,
  pipelineStep: r.pipeline_step === null ? null : Number(r.pipeline_step),
  sessionId: r.session_id,
  checkpoint: r.checkpoint,
  result: r.result,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  jobId: jobOf(r),
  worktree: job,
})

interface Running {
  id: number
  jobId: string
  sessionId: string
  /** Runs in the workspace itself (not a worktree) and may edit files. */
  editsInPlace: boolean
  errors: string[]
  sawBusy: boolean
}

/**
 * Persistent task queue for agent roles. A job (one task, or the steps of a pipeline) runs its tasks in
 * order, each in its own OpenCode session; pipeline steps receive the previous step's result as shared
 * context and a failed step cancels the rest of its pipeline. With one lane jobs run strictly one after
 * another in the workspace (a git checkpoint before every task). With more lanes, jobs that may edit files
 * run side by side, each in its own git worktree, and reach the workspace only when the operator merges them.
 */
export class TaskQueue {
  private readonly running = new Map<string, Running>()
  private pumping = false
  private repump = false

  constructor(private readonly deps: Deps) {
    const now = new Date().toISOString()
    // Tasks that were running when the app quit cannot be resumed reliably; their worktrees stay for review.
    deps.store.db
      .prepare(`UPDATE tasks SET status = 'interrupted', finished_at = ?, error = 'NETRUNNER was closed while the task was running' WHERE status = 'running'`)
      .run(now)
    deps.store.db.prepare(`UPDATE agent_jobs SET state = 'ready', updated_at = ? WHERE state = 'active'`).run(now)
  }

  private now(): string {
    return new Date().toISOString()
  }

  private lanes(): number {
    return Math.max(1, Math.min(4, Math.floor(this.deps.lanes?.() ?? 1)))
  }

  private row(id: number): Row {
    const r = this.deps.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error(`Task ${id} not found`)
    return r
  }

  private job(ws: string, id: string): AgentJob | null {
    const j = this.deps.store.db.prepare('SELECT * FROM agent_jobs WHERE workspace = ? AND id = ?').get(ws, id) as JobRow | undefined
    return j ? toJob(j) : null
  }

  private get(id: number): AgentTask {
    const r = this.row(id)
    const ws = (this.deps.store.db.prepare('SELECT workspace FROM tasks WHERE id = ?').get(id) as { workspace: string }).workspace
    return toTask(r, this.job(ws, jobOf(r)))
  }

  list(): AgentTask[] {
    const ws = this.deps.workspace()
    if (!ws) return []
    const jobs = new Map(
      (this.deps.store.db.prepare('SELECT * FROM agent_jobs WHERE workspace = ?').all(ws) as unknown as JobRow[]).map(j => [j.id, toJob(j)]),
    )
    return (this.deps.store.db.prepare('SELECT * FROM tasks WHERE workspace = ? ORDER BY id DESC LIMIT 200').all(ws) as unknown as Row[]).map(r =>
      toTask(r, jobs.get(jobOf(r)) ?? null),
    )
  }

  private changed(): void {
    this.deps.onChange(this.list())
  }

  private requireWorkspace(): string {
    const ws = this.deps.workspace()
    if (!ws) throw new Error('Open a workspace first')
    return ws
  }

  private insert(ws: string, role: AgentRole, prompt: string, useMemory: boolean, pipelineId: string | null, step: number | null, jobId: string | null): AgentTask {
    if (!ROLES.includes(role)) throw new Error(`Unknown role ${role}`)
    if (!prompt.trim()) throw new Error('Empty task')
    const db = this.deps.store.db
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO tasks (workspace, role, prompt, status, use_memory, pipeline_id, pipeline_step, created_at, job_id) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(ws, role, prompt.slice(0, 20000), useMemory ? 1 : 0, pipelineId, step, this.now(), jobId)
    const id = Number(lastInsertRowid)
    if (!jobId) db.prepare('UPDATE tasks SET job_id = ? WHERE id = ?').run(`j${id}`, id)
    return this.get(id)
  }

  enqueue(req: EnqueueRequest): AgentTask {
    const task = this.insert(this.requireWorkspace(), req.role, req.prompt, req.useMemory, null, null, null)
    this.changed()
    void this.pump()
    return task
  }

  enqueuePipeline(goal: string, useMemory: boolean): AgentTask[] {
    const ws = this.requireWorkspace()
    const pipelineId = crypto.randomUUID()
    const tasks = this.deps.store.tx(() => {
      const first = this.insert(ws, PIPELINE[0].role, goal, useMemory, pipelineId, 0, null)
      return [first, ...PIPELINE.slice(1).map((s, i) => this.insert(ws, s.role, goal, useMemory, pipelineId, i + 1, first.jobId))]
    })
    this.changed()
    void this.pump()
    return tasks
  }

  async cancel(id: number): Promise<AgentTask> {
    const t = this.get(id)
    if (t.status === 'queued') {
      this.finish(id, 'cancelled', null, 'cancelled by operator')
    } else if (t.status === 'running' && t.sessionId) {
      this.running.delete(t.sessionId)
      await this.deps.agent.abort(t.sessionId).catch(() => undefined)
      this.finish(id, 'cancelled', null, 'aborted by operator')
      void this.pump()
    }
    return this.get(id)
  }

  retry(id: number): AgentTask {
    const t = this.get(id)
    if (!['failed', 'cancelled', 'interrupted'].includes(t.status)) throw new Error('Only failed, cancelled or interrupted tasks can be retried')
    const copy = this.insert(this.requireWorkspace(), t.role, t.prompt, t.useMemory, null, null, null)
    this.changed()
    void this.pump()
    return copy
  }

  private finish(id: number, status: AgentTask['status'], result: string | null, error: string | null): void {
    const db = this.deps.store.db
    db.prepare('UPDATE tasks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?').run(status, result, error, this.now(), id)
    const t = this.get(id)
    if (status !== 'done' && t.pipelineId) {
      db.prepare(`UPDATE tasks SET status = 'cancelled', error = ?, finished_at = ? WHERE pipeline_id = ? AND status = 'queued'`).run(
        `previous step (${t.role}) ${status}`,
        this.now(),
        t.pipelineId,
      )
    }
    this.changed()
    void this.settleJob(t.jobId)
  }

  /** When a worktree job has nothing left to run: keep it for review if it changed files, otherwise remove it. */
  private async settleJob(jobId: string): Promise<void> {
    const ws = this.deps.workspace()
    const job = ws ? this.job(ws, jobId) : null
    if (!ws || !job || job.state !== 'active' || !this.deps.worktrees) return
    const pending = this.deps.store.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace = ? AND job_id = ? AND status IN ('queued','running')`)
      .get(ws, jobId) as { n: number }
    if (Number(pending.n) > 0) return
    const changes = await this.deps.worktrees.changes(job.base, job.path).then(c => c.length, () => null)
    if (changes === 0) await this.deps.worktrees.remove(job.path).catch(() => undefined)
    this.deps.store.db
      .prepare('UPDATE agent_jobs SET state = ?, changes = ?, updated_at = ? WHERE workspace = ? AND id = ?')
      .run(changes === 0 ? 'empty' : 'ready', changes, this.now(), ws, jobId)
    this.changed()
  }

  private requireReadyJob(jobId: string): { ws: string; job: AgentJob } {
    const ws = this.requireWorkspace()
    const job = this.job(ws, String(jobId))
    if (!job) throw new Error(`Job ${jobId} not found`)
    if (job.state !== 'ready') throw new Error(`Job ${jobId} is ${job.state}`)
    if ([...this.running.values()].some(r => r.jobId === job.id)) throw new Error(`Job ${jobId} is still running`)
    return { ws, job }
  }

  /** Files a worktree job changed (preview before MERGE). */
  async jobChanges(jobId: string): Promise<ChangedFile[]> {
    const ws = this.requireWorkspace()
    const job = this.job(ws, String(jobId))
    if (!job || (job.state !== 'ready' && job.state !== 'active')) return []
    return this.deps.worktrees!.changes(job.base, job.path)
  }
  /** Bring a finished job's changes into the workspace (checkpoint first), then remove its worktree. */
  async mergeJob(jobId: string): Promise<AgentJob> {
    const { ws, job } = this.requireReadyJob(jobId)
    const port = this.deps.worktrees!
    const res = await port.merge(job.base, job.path, `before merging agent job ${job.id}`)
    await port.remove(job.path).catch(() => undefined)
    this.deps.store.db
      .prepare(`UPDATE agent_jobs SET state = 'merged', merge_checkpoint = ?, conflicts = ?, updated_at = ? WHERE workspace = ? AND id = ?`)
      .run(res.checkpoint, JSON.stringify(res.conflicts), this.now(), ws, job.id)
    this.changed()
    return this.job(ws, job.id)!
  }

  async discardJob(jobId: string): Promise<AgentJob> {
    const { ws, job } = this.requireReadyJob(jobId)
    await this.deps.worktrees!.remove(job.path)
    this.deps.store.db.prepare(`UPDATE agent_jobs SET state = 'discarded', updated_at = ? WHERE workspace = ? AND id = ?`).run(this.now(), ws, job.id)
    this.changed()
    return this.job(ws, job.id)!
  }

  /** Previous successful steps of the same pipeline, oldest first. */
  private pipelineContext(t: AgentTask): string {
    if (!t.pipelineId || !t.pipelineStep) return ''
    const prev = (this.deps.store.db
      .prepare(`SELECT * FROM tasks WHERE pipeline_id = ? AND pipeline_step < ? AND status = 'done' ORDER BY pipeline_step`)
      .all(t.pipelineId, t.pipelineStep) as unknown as Row[]).map(r => toTask(r))
    return prev.map(p => `### Result of step ${p.pipelineStep! + 1} (${p.role.toUpperCase()})\n${(p.result ?? '').slice(0, 6000)}`).join('\n\n')
  }

  async buildPrompt(t: AgentTask): Promise<string> {
    const parts: string[] = []
    if (t.pipelineId !== null) {
      parts.push(`Goal: ${t.prompt}`, `Your step (${t.pipelineStep! + 1}/${PIPELINE.length}, ${t.role.toUpperCase()}): ${PIPELINE[t.pipelineStep!].instruction}`)
      const ctx = this.pipelineContext(t)
      if (ctx) parts.push(`Shared context from earlier steps (summaries written by the agents — treat them as claims):\n\n${ctx}`)
      if (t.pipelineStep && this.deps.verifiedFacts) {
        const previous = (this.deps.store.db
          .prepare(`SELECT * FROM tasks WHERE pipeline_id = ? AND pipeline_step < ? ORDER BY pipeline_step`)
          .all(t.pipelineId, t.pipelineStep) as unknown as Row[]).map(r => toTask(r))
        const facts = await this.deps.verifiedFacts(t, previous).catch(() => '')
        if (facts) parts.push(`## Verified facts (gathered by NETRUNNER from git and the tool logs, not written by an agent)\nWhen a summary above disagrees with these facts, the facts are right.\n\n${facts}`)
      }
    } else parts.push(t.prompt)
    if (t.useMemory) {
      const hits = await this.deps.searchMemory(t.prompt).catch(() => [])
      if (hits.length) parts.push(formatMemoryContext(hits.slice(0, 6), 8000))
    }
    return parts.join('\n\n')
  }

  /**
   * Where the task would run, or null when it has to wait: a job runs one task at a time, and at most one
   * task that edits the workspace itself runs at once.
   */
  private placement(ws: string, t: AgentTask, worktreesUsable: boolean): 'worktree' | 'inplace' | null {
    const busy = [...this.running.values()]
    if (busy.some(r => r.jobId === t.jobId)) return null
    const existing = this.job(ws, t.jobId)
    const readOnlySingle = t.pipelineId === null && READ_ONLY.includes(t.role)
    const mode = existing ? 'worktree' : this.lanes() > 1 && worktreesUsable && !readOnlySingle ? 'worktree' : 'inplace'
    if (mode === 'inplace' && !READ_ONLY.includes(t.role) && busy.some(r => r.editsInPlace)) return null
    return mode
  }

  /** Start queued tasks while lanes are free and the engine is running. */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true
      return
    }
    if (this.deps.agent.state.status !== 'running') return
    const ws = this.deps.workspace()
    if (!ws) return
    this.pumping = true
    try {
      do {
        this.repump = false
        const usable = this.lanes() > 1 && !!this.deps.worktrees && (await this.deps.worktrees.available().catch(() => false))
        while (this.running.size < this.lanes() && this.deps.agent.state.status === 'running') {
          const queued = (this.deps.store.db.prepare(`SELECT * FROM tasks WHERE workspace = ? AND status = 'queued' ORDER BY id`).all(ws) as unknown as Row[]).map(r =>
            toTask(r),
          )
          let next: { t: AgentTask; mode: 'worktree' | 'inplace' } | null = null
          for (const t of queued) {
            const mode = this.placement(ws, t, usable)
            if (mode) {
              next = { t, mode }
              break
            }
          }
          if (!next) break
          await this.startTask(ws, next.t, next.mode)
        }
      } while (this.repump)
    } finally {
      this.pumping = false
    }
  }

  private async startTask(ws: string, t: AgentTask, mode: 'worktree' | 'inplace'): Promise<void> {
    const db = this.deps.store.db
    const label = `task #${t.id} ${t.role}: ${t.prompt.slice(0, 80)}`
    try {
      let directory: string | undefined
      let checkpoint: string | null = null
      if (mode === 'worktree') {
        let job = this.job(ws, t.jobId)
        if (!job) {
          const wt = await this.deps.worktrees!.create(t.jobId, label)
          db.prepare(`INSERT INTO agent_jobs (id, workspace, path, base, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
            t.jobId,
            ws,
            wt.path,
            wt.base,
            this.now(),
            this.now(),
          )
          job = this.job(ws, t.jobId)!
        }
        directory = job.path
      } else checkpoint = await this.deps.checkpoint(label)
      const session = await this.deps.agent.createSession(`#${t.id} [${t.role.toUpperCase()}] ${t.prompt.slice(0, 80)}`, directory)
      db.prepare(`UPDATE tasks SET status = 'running', session_id = ?, checkpoint = ?, started_at = ? WHERE id = ?`).run(session.id, checkpoint, this.now(), t.id)
      this.running.set(session.id, { id: t.id, jobId: t.jobId, sessionId: session.id, editsInPlace: mode === 'inplace' && !READ_ONLY.includes(t.role), errors: [], sawBusy: false })
      this.changed()
      await this.deps.agent.prompt({ sessionId: session.id, role: t.role, text: await this.buildPrompt(this.get(t.id)) })
    } catch (err) {
      for (const [sid, r] of this.running) if (r.id === t.id) this.running.delete(sid)
      this.finish(t.id, 'failed', null, err instanceof Error ? err.message : String(err))
    }
  }

  /** Feed every agent engine event here. */
  onAgentEvent(ev: AgentEvent): void {
    if (ev.type === 'engine') {
      if (ev.state.status === 'running') void this.pump()
      else {
        const lost = [...this.running.values()]
        this.running.clear()
        for (const cur of lost) this.finish(cur.id, 'failed', null, `agent engine ${ev.state.status}${ev.state.error ? `: ${ev.state.error}` : ''}`)
      }
      return
    }
    const cur = 'sessionId' in ev && ev.sessionId ? this.running.get(ev.sessionId) : undefined
    if (!cur) return
    if (ev.type === 'error') cur.errors.push(ev.message)
    if (ev.type === 'status') {
      if (ev.busy) cur.sawBusy = true
      else if (cur.sawBusy) void this.complete(cur)
    }
  }

  private async complete(cur: Running): Promise<void> {
    if (this.running.get(cur.sessionId) !== cur) return
    this.running.delete(cur.sessionId)
    let result: string | null = null
    try {
      const history = await this.deps.agent.history(cur.sessionId)
      const texts = history.filter(p => p.kind === 'text' && p.role === 'assistant').map(p => (p.kind === 'text' ? p.text : ''))
      result = texts.at(-1)?.trim() || null
    } catch {
      /* history unavailable: keep result null */
    }
    if (cur.errors.length) this.finish(cur.id, 'failed', result, cur.errors.join('\n').slice(0, 4000))
    else if (!result) this.finish(cur.id, 'failed', null, 'agent finished without a final answer')
    else this.finish(cur.id, 'done', result, null)
    void this.pump()
  }
}
