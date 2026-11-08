import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Brain, Check, CheckCheck, ChevronDown, ChevronRight, GitBranch, GitCompare, GitMerge, Play, Power, RotateCcw, Send, ShieldAlert, Square, Trash2, Workflow, Wrench, X } from 'lucide-react'
import type { AgentPart, AgentPermission, AgentRole, AgentTask } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { useAgent } from '@/app/agent-store'
import { useAi } from '@/app/ai-store'
import { useStore } from '@/app/store'
import { useGitView } from '@/features/git/git-view-store'
import { PipelineGraph } from './PipelineGraph'
import { Markdown } from '@/components/Markdown'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'

const ROLES: { id: AgentRole; label: string; hint: string }[] = [
  { id: 'architect', label: 'ARCHITECT', hint: 'plans, read-only' },
  { id: 'coder', label: 'CODER', hint: 'edits files' },
  { id: 'debugger', label: 'DEBUGGER', hint: 'tests & fixes' },
  { id: 'reviewer', label: 'REVIEWER', hint: 'reviews, read-only' },
  { id: 'operator', label: 'OPERATOR', hint: 'runs commands' },
]

export function AgentControl() {
  const refresh = useAgent(s => s.refresh)
  const refreshAi = useAi(s => s.refresh)
  useEffect(() => {
    void refresh()
    void refreshAi()
  }, [refresh, refreshAi])

  return (
    <div className="grid h-full grid-cols-[250px_minmax(0,1fr)_340px] gap-2 p-2">
      <div className="flex min-h-0 flex-col gap-2">
        <EnginePanel />
        <JobsPanel />
        <QueuePanel />
      </div>
      <Transcript />
      <Approvals />
    </div>
  )
}

function EnginePanel() {
  const engine = useAgent(s => s.engine)
  const { start, stop } = useAgent.getState()
  const models = useAi(s => s.models)
  const details = useAi(s => s.details)
  const workspace = useStore(s => s.workspace)
  const agentRole = useAi(s => s.roles.agent)
  const toolModels = models.filter(m => details[m.name]?.capabilities.includes('tools'))
  const [model, setModel] = useState('')
  const t = useT()
  useEffect(() => {
    if (!model && toolModels.length) setModel(toolModels.find(m => m.name === agentRole)?.name ?? toolModels[0].name)
  }, [toolModels, model])

  const running = engine?.status === 'running'
  const color = running ? 'text-success' : engine?.status === 'error' ? 'text-critical' : engine?.status === 'starting' ? 'text-primary' : 'text-dim'
  return (
    <Panel title={t('AGENT ENGINE')} fit>
      <div className="flex flex-col gap-2 p-3 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 ${running ? 'bg-success' : engine?.status === 'error' ? 'bg-critical' : 'bg-dim'}`} />
          <span data-testid="agent-engine-status" className={color}>
            OPENCODE {engine?.status.toUpperCase() ?? '…'}
          </span>
          {engine?.version && <span className="text-dim">v{engine.version}</span>}
        </div>
        {engine?.error && <p className="text-[10.5px] break-words whitespace-pre-wrap text-critical">{engine.error.slice(0, 400)}</p>}
        <select
          data-testid="agent-model"
          aria-label={t('Agent model')}
          value={model}
          disabled={running || engine?.status === 'starting'}
          onChange={e => setModel(e.target.value)}
          className="border border-line bg-void px-1 py-1 text-text outline-none"
        >
          {toolModels.length === 0 && <option value="">{t('no tool-capable model')}</option>}
          {toolModels.map(m => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </select>
        {running ? (
          <button onClick={() => void stop()} className="hud-cut-sm flex items-center justify-center gap-1 border border-critical py-1 text-critical hover:bg-critical/10">
            <Power size={12} /> {t('STOP ENGINE')}
          </button>
        ) : (
          <button
            data-testid="agent-start"
            disabled={!workspace || !model || engine?.status === 'starting'}
            onClick={() => void start(model)}
            className="hud-cut-sm flex items-center justify-center gap-1 bg-primary py-1 font-bold text-void disabled:bg-line disabled:text-dim"
          >
            <Play size={12} /> {engine?.status === 'starting' ? t('STARTING…') : t('START ENGINE')}
          </button>
        )}
        {running && <LiveSpeed />}
        <LanesPicker />
        <p className="text-[10.5px] text-dim">
          {workspace ? `${t('workspace')}: ${workspace.name}` : t('open a workspace first')} · {t('provider: local llama.cpp only · edits and commands need approval')}
        </p>
      </div>
    </Panel>
  )
}

/** Generation speed of the agent model, from llama-server's token counters (OpenCode reports no timings). */
function LiveSpeed() {
  const [tps, setTps] = useState<number | null>(null)
  const t = useT()
  useEffect(() => {
    const poll = () => !document.hidden && void api.invoke('metrics:agent-live').then(r => setTps(r.tokensPerSecond), () => undefined)
    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span data-testid="agent-live-speed" className="text-[10.5px] text-dim">
      {t('model speed')}: <span className={tps ? 'text-success' : 'text-dim'}>{tps ? `${tps.toFixed(1)} tok/s` : t('idle')}</span>
    </span>
  )
}

/** How many agent jobs may run at once; the model server gets one sequence slot per job. */
function LanesPicker() {
  const lanes = useAgent(s => s.lanes)
  const engine = useAgent(s => s.engine)
  const setLanes = useAgent(s => s.setLanes)
  const running = engine?.status === 'running' || engine?.status === 'starting'
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-dim">{t('PARALLEL')}</span>
        {[1, 2, 3, 4].map(n => (
          <button
            key={n}
            data-lanes={n}
            onClick={() => void setLanes(n)}
            className={`w-6 border py-0.5 text-[10.5px] ${lanes === n ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted hover:text-text'}`}
          >
            {n}
          </button>
        ))}
        {running && engine.lanes !== lanes && <span className="ml-1 text-[10px] text-primary">{t('restart engine to apply')}</span>}
      </div>
      {lanes > 1 && (
        <p className="text-[10.5px] text-dim">
          {t('Editing jobs work in their own git worktree; nothing reaches the workspace until you MERGE. Each job takes one more 65K context slot in the model server.')}
        </p>
      )}
    </div>
  )
}

const JOB_STYLE: Record<string, string> = { active: 'text-primary', ready: 'text-success', empty: 'text-dim', merged: 'text-secondary', discarded: 'text-dim' }

/** Jobs that ran in a worktree: what they changed, and MERGE / DISCARD once they are done. */
function JobsPanel() {
  const tasks = useAgent(s => s.tasks)
  const jobFiles = useAgent(s => s.jobFiles)
  const { loadJobFiles, mergeJob, discardJob } = useAgent.getState()
  const setSection = useStore(s => s.setSection)
  const openReview = useGitView(s => s.openCheckpoint)
  const t = useT()
  const jobs = useMemo(() => {
    const seen = new Map<string, { job: NonNullable<AgentTask['worktree']>; tasks: AgentTask[] }>()
    for (const t of tasks) {
      if (!t.worktree) continue
      const e = seen.get(t.jobId) ?? { job: t.worktree, tasks: [] }
      e.tasks.push(t)
      seen.set(t.jobId, e)
    }
    // Live and reviewable jobs, plus merges that left conflicts to resolve.
    return [...seen.values()].filter(e => e.job.state === 'active' || e.job.state === 'ready' || (e.job.state === 'merged' && e.job.conflicts.length > 0)).slice(0, 8)
  }, [tasks])
  const readyKey = jobs.filter(e => e.job.state === 'ready').map(e => `${e.job.id}:${e.job.changes}`).join(',')
  useEffect(() => {
    for (const e of jobs) if (e.job.state === 'ready') void loadJobFiles(e.job.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey])
  if (!jobs.length) return null
  return (
    <Panel title={`${t('WORKTREE JOBS')} // ${jobs.length}`} accent="primary" fit>
      <ul data-testid="worktree-jobs" className="flex max-h-72 flex-col gap-2 overflow-auto p-2 font-mono text-[10.5px]">
        {jobs.map(({ job, tasks: jt }) => {
          const files = jobFiles[job.id] ?? []
          const first = jt[jt.length - 1]
          return (
            <li key={job.id} data-job={job.id} data-job-state={job.state} className="flex flex-col gap-1 border-l-2 border-primary/50 pl-2">
              <div className="flex items-center gap-2">
                <span className="text-text">{job.id}</span>
                <span className="truncate text-muted">{first.pipelineId ? t('PIPELINE') : t(first.role.toUpperCase())}</span>
                <span className={`ml-auto ${JOB_STYLE[job.state]}`}>{t(job.state)}</span>
              </div>
              <span className="truncate text-[11px] text-muted" title={first.prompt}>
                {first.prompt}
              </span>
              {job.state === 'ready' && (
                <>
                  <span className="text-dim">{t('{n} file(s) changed', { n: job.changes ?? files.length })}</span>
                  {files.slice(0, 6).map(f => (
                    <span key={f.path} className={`truncate ${f.status === 'A' ? 'text-success' : f.status === 'D' ? 'text-critical' : 'text-secondary'}`}>
                      {f.status} {f.path}
                    </span>
                  ))}
                  <div className="flex gap-1 pt-0.5">
                    <button data-job-merge={job.id} onClick={() => void mergeJob(job.id)} className="flex items-center gap-1 bg-success px-2 py-0.5 font-bold text-void">
                      <GitMerge size={11} /> {t('MERGE')}
                    </button>
                    <button data-job-discard={job.id} onClick={() => void discardJob(job.id)} className="flex items-center gap-1 border border-critical px-2 py-0.5 text-critical">
                      <Trash2 size={11} /> {t('DISCARD')}
                    </button>
                  </div>
                </>
              )}
              {job.state === 'merged' && (
                <>
                  <span className="text-critical">{t('conflicts')}: {job.conflicts.join(', ')}</span>
                  {job.mergeCheckpoint && (
                    <button
                      onClick={() => {
                        openReview(job.mergeCheckpoint!)
                        setSection('git')
                      }}
                      className="flex w-fit items-center gap-1 border border-secondary px-2 py-0.5 text-secondary"
                    >
                      <GitCompare size={11} /> {t('REVIEW MERGE')}
                    </button>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

const STATUS_STYLE: Record<AgentTask['status'], string> = {
  queued: 'text-muted',
  running: 'text-primary animate-pulse',
  done: 'text-success',
  failed: 'text-critical',
  cancelled: 'text-dim',
  interrupted: 'text-critical',
}

/** Persistent task queue (SQLite): one OpenCode session per task; jobs in order, several at once with PARALLEL > 1. */
function QueuePanel() {
  const tasks = useAgent(s => s.tasks)
  const selected = useAgent(s => s.selectedTask)
  const lanes = useAgent(s => s.engine?.lanes ?? s.lanes)
  const { selectTask, cancelTask, retryTask } = useAgent.getState()
  const queued = tasks.filter(t => t.status === 'queued').length
  const tr = useT()
  return (
    <Panel title={`${tr('TASK QUEUE')}${queued ? ` // ${tr('{n} WAITING', { n: queued })}` : ''}`} accent="secondary" className="flex-1">
      <ul data-testid="task-queue" className="h-full overflow-auto py-1">
        {tasks.length === 0 && (
          <li className="px-3 py-2 text-[12px] text-dim">
            {lanes > 1 ? tr('No tasks yet. Up to {n} jobs run at once; pipeline steps stay in order.', { n: lanes }) : tr('No tasks yet. Tasks run one at a time, in order.')}
          </li>
        )}
        {tasks.map(t => (
          <li key={t.id} data-task={t.id} data-task-status={t.status} data-task-role={t.role} className="group">
            <div
              role="button"
              tabIndex={0}
              onClick={() => void selectTask(t.id)}
              className={`flex cursor-pointer flex-col px-3 py-1.5 ${selected === t.id ? 'bg-secondary/10' : 'hover:bg-surface-2'}`}
            >
              <div className="flex items-center gap-2 font-mono text-[10.5px]">
                <span className="text-dim">#{t.id}</span>
                <span className="tracking-wider text-text">{tr(t.role.toUpperCase())}</span>
                {t.pipelineId && <span className="text-secondary">{tr('step')} {t.pipelineStep! + 1}/4</span>}
                {t.useMemory && <Brain size={10} className="text-secondary" />}
                {t.worktree && (
                  <span title={`${tr('Isolated worktree')} ${t.worktree.path}`} className="flex items-center gap-0.5 text-primary">
                    <GitBranch size={10} /> {t.jobId}
                  </span>
                )}
                <span className={`ml-auto ${STATUS_STYLE[t.status]}`}>{tr(t.status)}</span>
              </div>
              <span className="truncate text-[12px] text-muted">{t.prompt}</span>
              {t.error && <span className="truncate font-mono text-[10.5px] text-critical">{t.error}</span>}
              <div className="hidden gap-2 pt-1 font-mono text-[10px] group-hover:flex">
                {(t.status === 'queued' || t.status === 'running') && (
                  <button onClick={e => (e.stopPropagation(), void cancelTask(t.id))} className="flex items-center gap-1 text-critical">
                    <Ban size={10} /> {tr('CANCEL')}
                  </button>
                )}
                {['failed', 'cancelled', 'interrupted'].includes(t.status) && (
                  <button onClick={e => (e.stopPropagation(), void retryTask(t.id))} className="flex items-center gap-1 text-secondary">
                    <RotateCcw size={10} /> {tr('RETRY')}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Transcript() {
  const sessionId = useAgent(s => s.sessionId)
  const parts = useAgent(s => (s.sessionId ? s.parts[s.sessionId] : undefined))
  const busy = useAgent(s => (s.sessionId ? !!s.busy[s.sessionId] : false))
  const detail = useAgent(s => (s.sessionId ? s.statusDetail[s.sessionId] : null))
  const errors = useAgent(s => (s.sessionId ? s.errors[s.sessionId] : undefined))
  const tokens = useAgent(s => (s.sessionId ? s.tokens[s.sessionId] : undefined))
  const task = useAgent(s => s.tasks.find(t => t.id === s.selectedTask) ?? null)
  const checkpoint = task?.checkpoint ?? null
  const running = useAgent(s => s.engine?.status === 'running')
  const role = useAgent(s => s.role)
  const useMemory = useAgent(s => s.useMemory)
  const { enqueue, pipeline, cancelTask, setRole, setUseMemory, selectTask } = useAgent.getState()
  const allTasks = useAgent(s => s.tasks)
  const pipelineTasks = useMemo(() => (task?.pipelineId ? allTasks.filter(t => t.pipelineId === task.pipelineId) : []), [allTasks, task?.pipelineId])
  const setSection = useStore(s => s.setSection)
  const openReview = useGitView(s => s.openCheckpoint)
  const [text, setText] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const tr = useT()

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [parts])

  const submit = (asPipeline = false) => {
    if (!text.trim() || !running) return
    void (asPipeline ? pipeline(text.trim()) : enqueue(text.trim()))
    setText('')
  }

  return (
    <Panel title={`${tr('AGENT CONTROL')}${task ? ` // #${task.id} ${tr(task.role.toUpperCase())} ${tr(task.status).toUpperCase()}` : ''}`}>
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
          {ROLES.map(r => (
            <button
              key={r.id}
              data-role-select={r.id}
              title={tr(r.hint)}
              onClick={() => setRole(r.id)}
              className={`border px-2 py-0.5 font-mono text-[10.5px] tracking-wider ${role === r.id ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted hover:text-text'}`}
            >
              {tr(r.label)}
            </button>
          ))}
          <button
            data-testid="agent-memory"
            title={tr('Attach the closest code from project memory to each task')}
            onClick={() => setUseMemory(!useMemory)}
            className={`ml-2 flex items-center gap-1 border px-2 py-0.5 font-mono text-[10.5px] ${useMemory ? 'border-secondary text-secondary' : 'border-line text-muted'}`}
          >
            <Brain size={11} /> {tr('MEMORY')}
          </button>
          <span className="ml-auto font-mono text-[10.5px] text-dim">
            {tokens ? `${tr('last step')}: ${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out` : ''}
          </span>
        </div>

        {task?.pipelineId && <PipelineGraph tasks={pipelineTasks} parts={parts} onSelect={id => void selectTask(id)} />}
        <div ref={scroll} data-testid="agent-transcript" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {!running && <p className="m-auto font-mono text-[12px] text-dim">{tr('Start the agent engine to run tasks in this workspace.')}</p>}
          {running && !parts?.length && (
            <p className="m-auto max-w-lg text-center font-mono text-[12px] text-dim">
              {tr('RUN queues one task for the selected role. PIPELINE queues ARCHITECT → CODER → DEBUGGER → REVIEWER for the goal; each step gets the previous results. A git checkpoint is taken before every task.')}
            </p>
          )}
          {task?.result && !busy && parts && !parts.some(p => p.kind === 'text' && p.role === 'assistant') && (
            <div className="text-[12.5px] text-text select-text">
              <Markdown text={task.result} />
            </div>
          )}
          {parts?.map(p => <PartView key={p.id} part={p} />)}
          {errors?.map((e, i) => (
            <p key={i} className="font-mono text-[11.5px] text-critical">
              {tr('ERROR')}: {e}
            </p>
          ))}
          {busy && (
            <p className="animate-pulse font-mono text-[11px] text-primary">
              {tr('agent working')}{detail ? ` — ${detail}` : '…'}
            </p>
          )}
          {task?.worktree && (
            <p className="font-mono text-[10.5px] break-all text-dim">
              {tr('job {id} works in an isolated worktree ({path}) — its changes reach the workspace only through MERGE in WORKTREE JOBS.', { id: task.jobId, path: task.worktree.path })}
            </p>
          )}
          {!busy && checkpoint && parts?.some(p => p.kind === 'tool') && (
            <button
              data-testid="review-changes"
              onClick={() => {
                openReview(checkpoint)
                setSection('git')
              }}
              className="hud-cut-sm flex w-fit items-center gap-2 border border-secondary px-3 py-1 font-mono text-[11px] text-secondary hover:bg-secondary/10"
            >
              <GitCompare size={13} /> {tr('REVIEW CHANGES SINCE CHECKPOINT')}
            </button>
          )}
        </div>

        <div className="flex gap-2 border-t border-line p-2">
          <textarea
            data-testid="agent-input"
            value={text}
            disabled={!running}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            placeholder={tr('Task for {role} (Enter = RUN) — or a goal for the full PIPELINE', { role: tr(role.toUpperCase()) })}
            className="min-w-0 flex-1 resize-none border border-line bg-void p-2 text-[13px] text-text outline-none select-text placeholder:text-dim focus:border-secondary disabled:opacity-50"
          />
          <div className="flex w-24 flex-col gap-1">
            <button
              data-testid="agent-send"
              disabled={!running || !text.trim()}
              onClick={() => submit()}
              className="hud-cut-sm flex flex-1 items-center justify-center gap-1 bg-primary font-mono text-[10px] font-bold text-void disabled:bg-line disabled:text-dim"
            >
              <Send size={12} /> {tr('RUN')}
            </button>
            <button
              data-testid="agent-pipeline"
              title={tr('Queue ARCHITECT → CODER → DEBUGGER → REVIEWER')}
              disabled={!running || !text.trim()}
              onClick={() => submit(true)}
              className="hud-cut-sm flex flex-1 items-center justify-center gap-1 border border-secondary font-mono text-[10px] font-bold text-secondary disabled:border-line disabled:text-dim"
            >
              <Workflow size={12} /> {tr('PIPELINE')}
            </button>
            {busy && task?.status === 'running' && (
              <button onClick={() => void cancelTask(task.id)} className="flex items-center justify-center gap-1 bg-critical py-0.5 font-mono text-[10px] font-bold text-void">
                <Square size={10} /> {tr('ABORT')}
              </button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function PartView({ part }: { part: AgentPart }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  if (part.kind === 'text') {
    return (
      <div className={`flex flex-col gap-0.5 ${part.role === 'user' ? 'items-end' : 'items-start'}`}>
        <span className={`font-mono text-[10px] tracking-[0.2em] ${part.role === 'user' ? 'text-secondary' : 'text-primary'}`}>
          {part.role === 'user' ? t('OPERATOR') : t('AGENT')}
        </span>
        <div className={`hud-cut-sm max-w-[92%] px-3 py-2 text-[12.5px] select-text ${part.role === 'user' ? 'border border-secondary/30 bg-secondary/5 whitespace-pre-wrap' : 'border border-line bg-surface-2'}`}>
          {part.role === 'user' ? part.text : <Markdown text={part.text} />}
        </div>
      </div>
    )
  }
  if (part.kind === 'reasoning') {
    return part.text.trim() ? <p className="border-l-2 border-dim pl-2 text-[11.5px] whitespace-pre-wrap text-dim">{part.text.slice(0, 1200)}</p> : null
  }
  const color = part.status === 'completed' ? 'text-success' : part.status === 'error' ? 'text-critical' : 'text-primary'
  return (
    <div data-tool={part.tool} data-tool-status={part.status} className="border border-line bg-void font-mono text-[11px]">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-2">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className={color} />
        <span className="text-text">{part.tool}</span>
        <span className="truncate text-muted">{part.title}</span>
        <span className={`ml-auto ${color}`}>{part.status}</span>
      </button>
      {open && (
        <div className="border-t border-line p-2 select-text">
          <pre className="overflow-x-auto text-[11px] whitespace-pre-wrap text-muted">{JSON.stringify(part.input, null, 2).slice(0, 4000)}</pre>
          {(part.output || part.error) && (
            <pre className={`mt-2 max-h-72 overflow-auto text-[11px] whitespace-pre-wrap ${part.error ? 'text-critical' : 'text-text'}`}>
              {(part.error ?? part.output).slice(0, 12000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** Exported for component tests. */
export function Approvals() {
  const permissions = useAgent(s => s.permissions)
  const t = useT()
  return (
    <Panel title={`${t('APPROVALS')}${permissions.length ? ` // ${t('{n} PENDING', { n: permissions.length })}` : ''}`} accent={permissions.length ? 'primary' : 'secondary'}>
      <div data-testid="approvals" className="flex h-full flex-col gap-2 overflow-y-auto p-2">
        {permissions.length === 0 && (
          <p className="p-2 text-[12px] text-dim">
            {t('Nothing waiting. File edits and shell commands proposed by the agent appear here and run only after you approve them.')}
          </p>
        )}
        {permissions.map(p => (
          <PermissionCard key={p.id} p={p} />
        ))}
        <StandingApprovals />
      </div>
    </Panel>
  )
}

/** ALWAYS approvals of this engine run: exactly what each covers, how often it answered, revoke. */
function StandingApprovals() {
  const grants = useAgent(s => s.grants)
  const auto = useAgent(s => s.autoApproved)
  const revoke = useAgent(s => s.revokeGrant)
  const t = useT()
  if (!grants.length && !auto.length) return null
  return (
    <div data-testid="standing-approvals" className="mt-1 flex flex-col gap-1 border-t border-line pt-2 font-mono text-[10.5px]">
      {grants.length > 0 && <span className="tracking-wider text-success">{t('ALWAYS (until the engine stops)')}</span>}
      {grants.map(g => (
        <div key={g.key} data-grant={g.key} className="flex items-center gap-2">
          <span className="text-muted">{g.type.toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate text-text" title={g.what}>
            {g.what}
          </span>
          <span className="text-dim">×{g.uses}</span>
          <button title={t('Revoke')} onClick={() => void revoke(g.key)} className="text-dim hover:text-critical">
            <X size={11} />
          </button>
        </div>
      ))}
      {auto.slice(-5).map(a => (
        <span key={a.permission.id} data-auto-approved={a.permission.id} className="truncate text-dim" title={a.grant.what}>
          {t('auto-approved')} · {a.permission.type} · {a.grant.what}
        </span>
      ))}
    </div>
  )
}

/** Shows exactly what the agent wants to do (command or diff) before anything happens. */
function PermissionCard({ p }: { p: AgentPermission }) {
  const respond = useAgent(s => s.respond)
  // With parallel jobs, several agents ask at once: say which task each request comes from.
  const task = useAgent(s => s.tasks.find(t => t.sessionId === p.sessionId))
  const tr = useT()
  const diff = typeof p.metadata.diff === 'string' ? p.metadata.diff : null
  const command = typeof p.metadata.command === 'string' ? p.metadata.command : p.type === 'bash' ? p.pattern.join(' ') : null
  const lines = useMemo(() => (diff ? diff.split('\n').slice(0, 300) : []), [diff])
  return (
    <div data-permission={p.type} className="hud-cut-sm flex flex-col gap-2 border border-primary/50 bg-primary/5 p-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <ShieldAlert size={14} className="text-primary" />
        <span className="font-semibold tracking-wider text-primary">{p.type.toUpperCase()}</span>
        <span className="truncate text-text" title={p.title}>
          {p.title}
        </span>
      </div>
      {task && (
        <span data-permission-task={task.id} className="font-mono text-[10px] text-muted">
          #{task.id} {tr(task.role.toUpperCase())}
          {task.worktree ? ` · ${tr('worktree')} ${task.jobId}` : ` · ${tr('workspace')}`}
        </span>
      )}
      {command && <pre className="overflow-x-auto bg-void p-2 font-mono text-[11.5px] whitespace-pre-wrap text-secondary select-text">{command}</pre>}
      {diff && (
        <pre className="max-h-64 overflow-auto bg-void p-2 font-mono text-[11px] select-text">
          {lines.map((l, i) => (
            <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-success' : l.startsWith('-') && !l.startsWith('---') ? 'text-critical' : 'text-muted'}>
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
      {!diff && !command && p.pattern.length > 0 && <pre className="bg-void p-2 font-mono text-[11px] text-muted">{p.pattern.join('\n')}</pre>}
      <div className="flex gap-1 font-mono text-[10.5px]">
        <button data-approve="once" onClick={() => void respond(p, 'once')} className="flex flex-1 items-center justify-center gap-1 bg-success py-1 font-bold text-void">
          <Check size={12} /> {tr('APPROVE')}
        </button>
        <button title={tr('Approve this exact command or file now and until the engine stops (nothing broader)')} onClick={() => void respond(p, 'always')} className="flex items-center gap-1 border border-success px-2 py-1 text-success">
          <CheckCheck size={12} /> {tr('ALWAYS')}
        </button>
        <button data-approve="reject" onClick={() => void respond(p, 'reject')} className="flex items-center gap-1 border border-critical px-2 py-1 text-critical">
          <X size={12} /> {tr('REJECT')}
        </button>
      </div>
    </div>
  )
}
