import { Bug, Code2, Compass, ScanSearch } from 'lucide-react'
import type { AgentPart, AgentTask } from '../../../electron/shared/ipc'
import { useT } from '@/lib/i18n'

const STEPS = [
  { role: 'architect', label: 'ARCHITECT', icon: Compass },
  { role: 'coder', label: 'CODER', icon: Code2 },
  { role: 'debugger', label: 'DEBUGGER', icon: Bug },
  { role: 'reviewer', label: 'REVIEWER', icon: ScanSearch },
] as const

const NODE: Record<AgentTask['status'], string> = {
  queued: 'border-line text-dim',
  running: 'border-primary text-primary shadow-[0_0_14px_rgba(252,238,9,0.35)]',
  done: 'border-success text-success',
  failed: 'border-critical text-critical',
  cancelled: 'border-line text-dim line-through',
  interrupted: 'border-critical text-critical',
}

function duration(t: AgentTask): string {
  if (!t.startedAt) return ''
  const end = t.finishedAt ? new Date(t.finishedAt).getTime() : Date.now()
  return `${Math.round((end - new Date(t.startedAt).getTime()) / 1000)} s`
}

/** Live view of one pipeline: four role nodes, data flowing along the edge into the running step. */
export function PipelineGraph({ tasks, parts, onSelect }: { tasks: AgentTask[]; parts: AgentPart[] | undefined; onSelect: (id: number) => void }) {
  const ordered = STEPS.map(s => tasks.find(t => t.role === s.role) ?? null)
  const tools = (parts ?? []).filter(p => p.kind === 'tool')
  const tr = useT()
  return (
    <div data-testid="pipeline-graph" className="flex items-stretch gap-0 border-b border-line px-3 py-2">
      {STEPS.map((s, i) => {
        const t = ordered[i]
        const Icon = s.icon
        const next = ordered[i + 1]
        return (
          <div key={s.role} className="flex flex-1 items-center">
            <button
              data-pipeline-node={s.role}
              data-status={t?.status ?? 'none'}
              disabled={!t}
              onClick={() => t && onSelect(t.id)}
              className={`hud-cut-sm flex min-w-0 flex-1 flex-col items-center gap-0.5 border bg-void px-2 py-1.5 font-mono text-[10px] transition-shadow ${t ? NODE[t.status] : 'border-line text-dim'}`}
            >
              <Icon size={15} className={t?.status === 'running' ? 'animate-pulse' : ''} />
              <span className="tracking-wider">{s.label}</span>
              <span className="text-[9.5px] opacity-80">
                {t ? `${tr(t.status)}${duration(t) ? ` · ${duration(t)}` : ''}` : '—'}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <svg viewBox="0 0 40 10" className="h-3 w-8 shrink-0" aria-hidden>
                <line
                  x1="0"
                  y1="5"
                  x2="40"
                  y2="5"
                  stroke={t?.status === 'done' ? 'var(--color-success)' : 'var(--color-line-bright)'}
                  strokeWidth="2"
                  strokeDasharray={next?.status === 'running' ? '4 4' : undefined}
                  className={next?.status === 'running' ? 'pipeline-flow' : undefined}
                />
              </svg>
            )}
          </div>
        )
      })}
      <div className="ml-3 flex w-28 shrink-0 flex-col justify-center font-mono text-[10px] text-dim">
        <span>{tr('tools in view')}: {tools.length}</span>
        <span className="text-success">✓ {tools.filter(t => t.kind === 'tool' && t.status === 'completed').length}</span>
        <span className="text-critical">✕ {tools.filter(t => t.kind === 'tool' && t.status === 'error').length}</span>
      </div>
    </div>
  )
}
