import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Settings2 } from 'lucide-react'
import type { ModelPerf, RunningModel, TaskPerf, TelemetrySample } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { Bar, Sparkline } from '@/components/charts/Sparkline'
import { useTelemetry, useTelemetrySubscription } from '@/app/telemetry-store'
import { useAi } from '@/app/ai-store'
import { useRi } from '@/app/ri-store'
import { InterferencePanel } from '@/components/hud/Interference'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/fit'
import { useT } from '@/lib/i18n'

type WidgetId = 'interference' | 'cpu' | 'cores' | 'memory' | 'gpu' | 'runtime' | 'inference' | 'agents' | 'disks' | 'network'

const WIDGETS: { id: WidgetId; title: string; wide?: boolean }[] = [
  { id: 'interference', title: 'INTERFERENCE', wide: true },
  { id: 'cpu', title: 'CPU' },
  { id: 'memory', title: 'MEMORY' },
  { id: 'gpu', title: 'GPU' },
  { id: 'runtime', title: 'AI RUNTIME' },
  { id: 'inference', title: 'INFERENCE PERFORMANCE', wide: true },
  { id: 'cores', title: 'CPU CORES' },
  { id: 'agents', title: 'AGENT TASKS' },
  { id: 'disks', title: 'DISKS' },
  { id: 'network', title: 'NETWORK THROUGHPUT' },
]

const STORAGE_KEY = 'netrunner.system.layout.v1'

interface Layout {
  order: WidgetId[]
  hidden: WidgetId[]
}

function loadLayout(): Layout {
  const def = { order: WIDGETS.map(w => w.id), hidden: [] as WidgetId[] }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Layout | null
    if (!raw) return def
    const known = new Set(WIDGETS.map(w => w.id))
    const order = raw.order.filter(id => known.has(id))
    for (const w of WIDGETS) if (!order.includes(w.id)) order.push(w.id)
    return { order, hidden: raw.hidden.filter(id => known.has(id)) }
  } catch {
    return def
  }
}

function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l))
  } catch {
    /* storage unavailable: layout lasts for this session only */
  }
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(0)}%`)
const rate = (bps: number | null) => (bps === null ? '—' : `${formatBytes(bps)}/s`)

export function SystemMonitor() {
  useTelemetrySubscription()
  const samples = useTelemetry(s => s.samples)
  const last = samples.at(-1) ?? null
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [editing, setEditing] = useState(false)
  const t = useT()

  const update = (l: Layout) => {
    setLayout(l)
    saveLayout(l)
  }
  const move = (id: WidgetId, dir: -1 | 1) => {
    const order = [...layout.order]
    const i = order.indexOf(id)
    const j = i + dir
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    update({ ...layout, order })
  }
  const toggle = (id: WidgetId) =>
    update({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter(h => h !== id) : [...layout.hidden, id] })

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div className="flex items-center gap-3 px-1 font-mono text-[10.5px] text-dim">
        <span>
          {t('LIVE')} · {t('{n} samples', { n: samples.length })} · {t('every 2 s')} · {last ? new Date(last.time).toLocaleTimeString() : t('waiting for first sample')}
        </span>
        <button
          data-testid="customize-widgets"
          onClick={() => setEditing(e => !e)}
          className={`ml-auto flex items-center gap-1 border px-2 py-0.5 ${editing ? 'border-primary text-primary' : 'border-line text-muted hover:text-text'}`}
        >
          <Settings2 size={11} /> {editing ? t('DONE') : t('CUSTOMIZE')}
        </button>
      </div>
      <div data-testid="system-widgets" className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
        {layout.order
          .filter(id => editing || !layout.hidden.includes(id))
          .map(id => {
            const def = WIDGETS.find(w => w.id === id)!
            const hidden = layout.hidden.includes(id)
            return (
              <div key={id} data-widget={id} className={`${def.wide ? 'lg:col-span-2' : ''} ${hidden ? 'opacity-40' : ''}`}>
                <Panel
                  title={t(def.title)}
                  fit
                  accent={id === 'inference' || id === 'agents' ? 'secondary' : 'primary'}
                  actions={
                    editing ? (
                      <>
                        <IconButton title={t('Move earlier')} onClick={() => move(id, -1)}>
                          <ArrowUp size={12} />
                        </IconButton>
                        <IconButton title={t('Move later')} onClick={() => move(id, 1)}>
                          <ArrowDown size={12} />
                        </IconButton>
                        <IconButton title={hidden ? t('Show') : t('Hide')} onClick={() => toggle(id)}>
                          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </IconButton>
                      </>
                    ) : null
                  }
                >
                  <div className="min-h-[120px] p-3">{last || id === 'inference' || id === 'agents' || id === 'interference' ? <Widget id={id} samples={samples} last={last} /> : <Waiting />}</div>
                </Panel>
              </div>
            )
          })}
      </div>
    </div>
  )
}

function RiWidget() {
  const state = useRi(s => s.state)
  return <InterferencePanel state={state} />
}

function Waiting() {
  const t = useT()
  return <p className="font-mono text-[11px] text-dim">{t('sampling…')}</p>
}

function Stat({ k, v, accent }: { k: string; v: ReactNode; accent?: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[9.5px] tracking-widest text-dim">{k}</span>
      <span className={`font-mono text-[18px] font-semibold ${accent ?? 'text-text'}`}>{v}</span>
    </div>
  )
}

function Widget({ id, samples, last }: { id: WidgetId; samples: TelemetrySample[]; last: TelemetrySample | null }) {
  const t = useT()
  switch (id) {
    case 'interference':
      return <RiWidget />
    case 'cpu':
      return (
        <div data-testid="widget-cpu" className="flex flex-col gap-2">
          <div className="flex gap-6">
            <Stat k={t('LOAD')} v={pct(last!.cpuPct)} accent="text-primary" />
            <Stat k={t('TEMP')} v={last!.cpuTempC === null ? 'n/a' : `${last!.cpuTempC}°C`} />
            <Stat k={t('THREADS')} v={last!.cpuCores.length} />
          </div>
          <Sparkline values={samples.map(s => s.cpuPct)} max={100} color="var(--color-primary)" label="CPU load history" />
          <span className="truncate font-mono text-[10px] text-dim" title={last!.cpuModel}>
            {last!.cpuModel}
            {last!.cpuTempC === null ? ` · ${t('temperature not exposed by Windows without a vendor driver')}` : ''}
          </span>
        </div>
      )
    case 'cores':
      return (
        <div className="grid grid-cols-8 gap-1" aria-label="Per-core load">
          {last!.cpuCores.map((c, i) => (
            <div key={i} title={`core ${i}: ${c.toFixed(0)}%`} className="flex h-10 flex-col justify-end bg-line">
              <div className="bg-primary transition-[height] duration-500" style={{ height: `${c}%`, opacity: 0.35 + c / 160 }} />
            </div>
          ))}
        </div>
      )
    case 'memory':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex gap-6">
            <Stat k={t('USED')} v={formatBytes(last!.ramUsedBytes)} accent="text-secondary" />
            <Stat k={t('TOTAL')} v={formatBytes(last!.ramTotalBytes)} />
            <Stat k="NETRUNNER" v={formatBytes(last!.appMemBytes)} />
          </div>
          <Sparkline values={samples.map(s => s.ramUsedBytes)} max={last!.ramTotalBytes} label="RAM history" />
        </div>
      )
    case 'gpu': {
      if (!last!.gpus.length) return <p className="font-mono text-[11px] text-critical">{last!.gpuError ?? t('No GPU data')}</p>
      const g = last!.gpus[0]
      return (
        <div data-testid="widget-gpu" className="flex flex-col gap-2">
          <div className="flex gap-5">
            <Stat k={t('UTIL')} v={pct(g.utilizationPct)} accent="text-primary" />
            <Stat k={t('TEMP')} v={g.temperatureC === null ? 'n/a' : `${Math.round(g.temperatureC)}°C`} />
            <Stat k={t('POWER')} v={g.powerW === null ? 'n/a' : `${g.powerW.toFixed(0)} W`} />
            <Stat k={t('CLOCK')} v={g.clockMhz === null ? 'n/a' : `${g.clockMhz} MHz`} />
          </div>
          <Sparkline values={samples.map(s => s.gpus[0]?.utilizationPct ?? null)} max={100} color="var(--color-primary)" label="GPU utilization history" />
          <Bar label={`VRAM · ${g.name}`} value={g.vramUsedBytes} max={g.vramTotalBytes} text={`${formatBytes(g.vramUsedBytes)} / ${formatBytes(g.vramTotalBytes)}`} color="bg-primary" />
        </div>
      )
    }
    case 'runtime':
      return <RuntimeWidget last={last!} />
    case 'inference':
      return <InferenceWidget />
    case 'agents':
      return <AgentsWidget />
    case 'disks':
      return last!.disks ? (
        <div className="flex flex-col gap-2">
          {last!.disks.map(d => (
            <Bar key={d.mount} label={d.mount} value={d.usedBytes} max={d.sizeBytes} text={`${formatBytes(d.usedBytes)} / ${formatBytes(d.sizeBytes)}`} color={d.usedBytes / d.sizeBytes > 0.9 ? 'bg-critical' : 'bg-secondary'} />
          ))}
        </div>
      ) : (
        <Waiting />
      )
    case 'network':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex gap-6">
            <Stat k={t('DOWN')} v={rate(last!.netRxBps)} accent="text-secondary" />
            <Stat k={t('UP')} v={rate(last!.netTxBps)} />
          </div>
          <Sparkline values={samples.map(s => s.netRxBps)} label="Download history" />
          <span className="font-mono text-[10px] text-dim">{t('All interfaces, whole machine (not only NETRUNNER).')}</span>
        </div>
      )
  }
}

function RuntimeWidget({ last }: { last: TelemetrySample }) {
  const [running, setRunning] = useState<RunningModel[]>([])
  const t = useT()
  useEffect(() => {
    const load = () => !document.hidden && void api.invoke('models:running').then(setRunning, () => setRunning([]))
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div data-testid="widget-runtime" className="flex flex-col gap-2 font-mono text-[11px]">
      {running.length === 0 && <span className="text-dim">{t('no model loaded in llama.cpp')}</span>}
      {running.map(m => (
        <Bar key={m.name} label={`${useAi.getState().label(m.name)}${m.contextLength ? ` · ctx ${m.contextLength}` : ''}`} value={m.sizeVramBytes} max={m.sizeBytes} text={`${formatBytes(m.sizeVramBytes)} VRAM / ${formatBytes(m.sizeBytes)}`} color="bg-success" />
      ))}
      <div className="mt-1 border-t border-line pt-1">
        {last.processes === null && <span className="text-dim">{t('reading processes…')}</span>}
        {last.processes?.length === 0 && <span className="text-dim">{t('no llama-server / opencode processes')}</span>}
        {last.processes?.map(p => (
          <div key={p.name} className="flex justify-between">
            <span className="text-muted">
              {p.name} ×{p.pids}
            </span>
            <span className="text-text">
              {p.cpuPct.toFixed(1)}% CPU · {formatBytes(p.memBytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function InferenceWidget() {
  const [data, setData] = useState<{ recent: { model: string; tokensPerSecond: number; time: string }[]; perModel: ModelPerf[] } | null>(null)
  const t = useT()
  useEffect(() => {
    const load = () => void api.invoke('metrics:inference', 200).then(setData, () => undefined)
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])
  if (!data) return <Waiting />
  if (!data.perModel.length) return <p className="font-mono text-[11px] text-dim">{t('No measured runs yet. Every NEURAL CORE reply is recorded with its real tokens/s.')}</p>
  const best = Math.max(...data.perModel.map(m => m.bestTokensPerSecond))
  return (
    <div data-testid="widget-inference" className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        {data.perModel.map(m => (
          <Bar
            key={m.model}
            label={`${useAi.getState().label(m.model)} · ${m.runs} run${m.runs === 1 ? '' : 's'} · prompt ${m.avgPromptTokensPerSecond.toFixed(0)} tok/s · load ${(m.avgLoadMs / 1000).toFixed(1)} s`}
            value={m.avgTokensPerSecond}
            max={best}
            text={`${m.avgTokensPerSecond.toFixed(1)} tok/s (best ${m.bestTokensPerSecond.toFixed(1)})`}
            color="bg-success"
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] text-dim">{t('generation speed of the last {n} replies (tok/s)', { n: data.recent.length })}</span>
        <Sparkline values={data.recent.map(r => r.tokensPerSecond)} color="var(--color-success)" height={70} label="Recent generation speed" />
      </div>
    </div>
  )
}

function AgentsWidget() {
  const [perf, setPerf] = useState<TaskPerf[] | null>(null)
  const t = useT()
  useEffect(() => {
    void api.invoke('metrics:tasks').then(setPerf, () => setPerf([]))
  }, [])
  if (!perf) return <Waiting />
  if (!perf.length) return <p className="font-mono text-[11px] text-dim">{t('No agent tasks have run yet.')}</p>
  const max = Math.max(...perf.map(p => p.avgSeconds), 1)
  return (
    <div className="flex flex-col gap-2">
      {perf.map(p => (
        <Bar key={p.role} label={`${p.role.toUpperCase()} · ${p.done}/${p.runs} done${p.failed ? ` · ${p.failed} failed` : ''}`} value={p.avgSeconds} max={max} text={`${p.avgSeconds.toFixed(0)} s avg${p.avgTokensPerSecond !== null ? ` · ${p.avgTokensPerSecond.toFixed(1)} tok/s` : ''}`} color={p.failed ? 'bg-primary' : 'bg-secondary'} />
      ))}
    </div>
  )
}
