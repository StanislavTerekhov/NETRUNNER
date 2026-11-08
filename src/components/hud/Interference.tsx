import { useEffect, useState } from 'react'
import type { RiFinding, RiResource, RiState } from '../../../electron/shared/ipc'
import { useAi } from '@/app/ai-store'
import { useRi } from '@/app/ri-store'
import { useStore } from '@/app/store'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/lib/i18n'

const RESOURCE: Record<RiResource, string> = { cpu: 'CPU', ram: 'RAM', vram: 'VRAM', gpu: 'GPU' }
const COLOR = { critical: 'text-critical', warn: 'text-primary', info: 'text-secondary' } as const

/** What a finding means for the operator, with the measured value and the threshold. */
export function useFindingText(): (f: RiFinding) => string {
  const t = useT()
  return f => {
    const v = { value: f.value, limit: f.limit }
    switch (f.kind) {
      case 'ram-pressure':
        return t('Almost no free RAM: {value} GB. Down to 1.2 GB the model was not slower; below that Windows may evict model weights.', v)
      case 'vram-others':
        return t('Other programs took {value} GB of VRAM after the model was placed, and the card is full: Windows moves model memory out of the GPU without telling anyone. Measured: Coder-Next 2× slower (23 → 12 tok/s); with VRAM SAVER it kept its full speed.', v)
      case 'cpu-contention':
        return t('Other programs use {value}% of the CPU (limit {limit}%). Measured at 81%: generation 39% slower.', v)
      case 'speed-drop':
        return t('{model}: {value} tok/s instead of the usual {usual} tok/s.', { ...v, model: f.model ?? '', usual: f.usual ?? 0 })
    }
  }
}

/**
 * NSC-ME phase 6, what to do when others filled the VRAM: a MoE chat model goes to VRAM SAVER (all experts in RAM,
 * −5 GB VRAM, −9% speed, reloads in seconds); a dense one can only be unloaded (2 GB less VRAM costs it half its speed).
 */
function VramActions() {
  const t = useT()
  const running = useAi(s => s.running)
  const models = useAi(s => s.models)
  const details = useAi(s => s.details)
  const [note, setNote] = useState<string | null>(null)
  const chat = running.filter(r => r.expiresAt === 'ready' && models.find(m => m.name === r.name)?.kind === 'chat')
  const missing = chat.filter(r => !details[r.name]).map(r => r.name).join('|')
  useEffect(() => {
    if (missing) for (const n of missing.split('|')) void useAi.getState().loadDetails(n)
  }, [missing])
  if (!chat.length) return null
  const saver = async (model: string) => {
    await api.invoke('settings:set-vram-saver', model, true)
    try {
      await api.invoke('models:unload', model)
      setNote(t('VRAM SAVER is on; the model loads with it at the next request.'))
    } catch (err) {
      setNote(`${t('VRAM SAVER is on; it applies at the next model load.')} ${errorMessage(err)}`)
    }
  }
  const unload = (model: string) => void api.invoke('models:unload', model).then(() => setNote(t('Unloaded.')), err => setNote(errorMessage(err)))
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1">
      {chat.map(r =>
        details[r.name]?.experts ? (
          <button key={r.name} data-testid="ri-vram-saver" onClick={() => void saver(r.name)} className="border border-primary px-1.5 text-[10px] text-primary hover:bg-primary/10" title={r.name}>
            {t('VRAM SAVER')}: {r.name.split('/').pop() ?? r.name}
          </button>
        ) : (
          <button key={r.name} data-testid="ri-unload" onClick={() => unload(r.name)} className="border border-line px-1.5 text-[10px] text-muted hover:text-critical" title={r.name}>
            {t('UNLOAD')}: {r.name.split('/').pop() ?? r.name}
          </button>
        ),
      )}
      {note && <span className="text-secondary">{note}</span>}
    </span>
  )
}

const rank = (f: RiFinding) => (f.severity === 'critical' ? 0 : f.severity === 'warn' ? 1 : 2)

/** Status bar badge: hidden while no model is loaded; click opens SYSTEM MONITOR. */
export function InterferenceBadge() {
  const state = useRi(s => s.state)
  const setSection = useStore(s => s.setSection)
  const t = useT()
  if (!state?.active) return null
  const problems = state.findings.filter(f => f.severity !== 'info')
  const worst = [...problems].sort((a, b) => rank(a) - rank(b))[0]
  return (
    <button data-testid="ri-badge" onClick={() => setSection('system')} className={`${worst ? COLOR[worst.severity] : 'text-success'} hover:underline`}>
      {worst ? t('INTERFERENCE: {n}', { n: problems.length }) : t('NO INTERFERENCE')}
    </button>
  )
}

/** SYSTEM MONITOR widget: current findings, NETRUNNER's share of each resource, and what happened recently. */
export function InterferencePanel({ state }: { state: RiState | null }) {
  const t = useT()
  const text = useFindingText()
  if (!state?.active) return <p className="font-mono text-[11px] text-dim">{t('Watching starts when a model is loaded.')}</p>
  const findings = [...state.findings].sort((a, b) => rank(a) - rank(b))
  const share = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`)
  const kindLabel = { 'ram-pressure': t('low free RAM'), 'vram-others': t('VRAM taken by others'), 'cpu-contention': t('CPU taken by others'), 'speed-drop': t('slower than usual') }
  return (
    <div data-testid="widget-interference" className="flex flex-col gap-3 font-mono text-[11px]">
      <table className="w-full text-left">
        <thead className="text-[9.5px] tracking-widest text-dim">
          <tr>
            <th className="font-normal" />
            {(Object.keys(RESOURCE) as RiResource[]).map(r => (
              <th key={r} className="font-normal">
                {RESOURCE[r]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="text-dim">NETRUNNER</td>
            {(Object.keys(RESOURCE) as RiResource[]).map(r => (
              <td key={r} className="text-text">
                {share(state.own[r])}
              </td>
            ))}
          </tr>
          <tr>
            <td className="text-dim">{t('ALL')}</td>
            {(Object.keys(RESOURCE) as RiResource[]).map(r => (
              <td key={r}>{share(state.total[r])}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {findings.length === 0 ? (
        <p className="text-success">{t('Nothing slows the models down right now.')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {findings.map(f => (
            <li key={`${f.kind}:${f.resource ?? ''}:${f.model ?? ''}`} className={COLOR[f.severity]}>
              {text(f)} <span className="text-dim">· {t('since {time}', { time: new Date(f.since).toLocaleTimeString() })}</span>
              {f.kind === 'vram-others' && <VramActions />}
            </li>
          ))}
        </ul>
      )}
      {state.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-dim">{t('Earlier ({n})', { n: state.history.length })}</summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-dim">
            {state.history.slice(0, 10).map(h => (
              <li key={`${h.kind}:${h.since}`}>
                {new Date(h.since).toLocaleTimeString()}–{new Date(h.until).toLocaleTimeString()} · {kindLabel[h.kind]}
                {h.resource ? ` ${RESOURCE[h.resource]}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
