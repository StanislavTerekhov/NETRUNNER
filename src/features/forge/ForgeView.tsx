import { useEffect, useRef, useState } from 'react'
import { Play, RefreshCw, Square } from 'lucide-react'
import type { ForgeEnv, ForgeJob, ForgeStep } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { api, errorMessage } from '@/lib/api'
import { useStore } from '@/app/store'
import { useAi } from '@/app/ai-store'
import { ForgePanel } from '@/features/models/ModelVault'
import { useT } from '@/lib/i18n'

const STEPS: { id: ForgeStep; label: string; hint: string }[] = [
  { id: 'setup', label: 'SETUP', hint: 'Install the Python environment (~15 GB, ONLINE TOOLS)' },
  { id: 'dataset', label: 'DATASET', hint: 'Teacher Qwen3-Coder-Next writes Q&A about the open workspace, answered from project memory' },
  { id: 'train', label: 'TRAIN', hint: 'Qwen3.5-4B bf16 LoRA on the GPU' },
  { id: 'merge', label: 'MERGE', hint: 'Fold the adapter into the weights' },
  { id: 'export', label: 'EXPORT', hint: 'GGUF Q4_K_M into the models folder' },
  { id: 'export-base', label: 'EXPORT BASE', hint: 'Untouched base, once, for the comparison' },
  { id: 'evaluate', label: 'EVALUATE', hint: 'Base vs tuned on held-out files, judged by Qwen3.8-27B' },
  { id: 'bench', label: 'BENCH', hint: 'MMLU, GSM8K, HumanEval: base vs tuned' },
]

/** FORGE from the UI: environment check, a run with chosen steps, live output, finished runs. */
export function ForgeView() {
  const [env, setEnv] = useState<ForgeEnv | null>(null)
  const [job, setJob] = useState<ForgeJob | null>(null)
  const workspace = useStore(s => s.workspace)
  const online = useAi(s => s.settings?.networkMode === 'online-tools')
  const [run, setRun] = useState('netrunner-v3')
  const [steps, setSteps] = useState<ForgeStep[]>(['dataset', 'train', 'merge', 'export', 'evaluate', 'bench'])
  const [maxChunks, setMaxChunks] = useState('')
  const [epochs, setEpochs] = useState('3')
  const [runsKey, setRunsKey] = useState(0)
  const logRef = useRef<HTMLPreElement>(null)
  const t = useT()

  const loadEnv = () => void api.invoke('forge:env').then(setEnv, () => setEnv(null))
  useEffect(() => {
    loadEnv()
    void useAi.getState().refresh()
    void api.invoke('forge:state').then(setJob)
    return api.on('forge:event', ({ job: j }) => {
      setJob(j)
      if (j.status !== 'running') {
        loadEnv()
        setRunsKey(k => k + 1)
      }
    })
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [job?.log.length])

  const running = job?.status === 'running'
  const start = async () => {
    try {
      setJob(await api.invoke('forge:start', { run, steps, workspace: '', maxChunks: Number(maxChunks) || undefined, epochs: Number(epochs) || undefined }))
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    }
  }
  const toggle = (s: ForgeStep) => setSteps(cur => (cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]))
  const check = (ok: boolean | undefined, label: string, detail?: string | null) => (
    <li data-forge-env={label} data-ok={!!ok} className="flex gap-2">
      <span className={ok ? 'text-success' : 'text-critical'}>{ok ? '✓' : '✕'}</span>
      <span className={ok ? 'text-text' : 'text-muted'}>{t(label)}</span>
      {detail && <span className="truncate text-dim">{detail}</span>}
    </li>
  )

  return (
    <div className="grid h-full grid-cols-[360px_minmax(0,1fr)] gap-2 p-2">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <Panel
          title={`FORGE // ${t('ENVIRONMENT')}`}
          accent="secondary"
          fit
          actions={
            <IconButton title={t('Re-check')} onClick={loadEnv}>
              <RefreshCw size={12} />
            </IconButton>
          }
        >
          <ul data-testid="forge-env" className="flex flex-col gap-1 p-3 font-mono text-[11px]">
            {!env && <li className="text-dim">{t('checking…')}</li>}
            {env && (
              <>
                {check(env.scripts, 'pipeline scripts')}
                {check(env.venv, 'training venv (PyTorch CUDA, Unsloth)')}
                {check(env.convertVenv, 'converter venv')}
                {check(env.converter, 'llama.cpp converter')}
                {check(env.quantize, 'llama-quantize')}
                {check(env.baseWeights, 'base weights Qwen3.5-4B (HF cache)')}
                {check(!!env.systemPython, 'Python 3.13 (for SETUP)', env.systemPython)}
                <li className="pt-1 text-[10.5px] break-all text-dim">{env.home}</li>
              </>
            )}
          </ul>
        </Panel>
        <Panel title={`FORGE // ${t('NEW RUN')}`} fit>
          <div className="flex flex-col gap-2 p-3 font-mono text-[11px]">
            <label className="flex items-center gap-2 text-muted">
              {t('RUN')}
              <input data-testid="forge-run" value={run} onChange={e => setRun(e.target.value)} disabled={running} className="min-w-0 flex-1 border border-line bg-void px-2 py-0.5 text-text outline-none focus:border-secondary" />
            </label>
            <div className="flex flex-col gap-1">
              {STEPS.map(s => (
                <label key={s.id} title={t(s.hint)} className="flex items-center gap-2">
                  <input type="checkbox" data-forge-step={s.id} checked={steps.includes(s.id)} disabled={running} onChange={() => toggle(s.id)} />
                  <span className={steps.includes(s.id) ? 'text-text' : 'text-muted'}>{t(s.label)}</span>
                  <span className="truncate text-[10px] text-dim">{t(s.hint)}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <label className="flex items-center gap-1 text-muted">
                {t('CHUNKS')}
                <input data-testid="forge-chunks" value={maxChunks} onChange={e => setMaxChunks(e.target.value.replace(/\D/g, ''))} placeholder={t('all')} disabled={running} className="w-14 border border-line bg-void px-1 text-text outline-none" />
              </label>
              <label className="flex items-center gap-1 text-muted">
                {t('EPOCHS')}
                <input data-testid="forge-epochs" value={epochs} onChange={e => setEpochs(e.target.value.replace(/[^\d.]/g, ''))} disabled={running} className="w-12 border border-line bg-void px-1 text-text outline-none" />
              </label>
            </div>
            <p className="text-[10.5px] text-dim">
              {t('dataset from')}: {workspace?.name ?? t('no workspace open')} · {t('everything runs on this machine, offline except SETUP')}{steps.includes('setup') && !online ? ` (${t('needs ONLINE TOOLS')})` : ''}. {t("The app's model servers are stopped while FORGE runs.")}
            </p>
            {running ? (
              <button data-testid="forge-cancel" onClick={() => void api.invoke('forge:cancel').then(setJob)} className="hud-cut-sm flex items-center justify-center gap-1 bg-critical py-1 font-bold text-void">
                <Square size={12} /> {t('CANCEL')}
              </button>
            ) : (
              <button data-testid="forge-start" disabled={!steps.length || !run.trim()} onClick={() => void start()} className="hud-cut-sm flex items-center justify-center gap-1 bg-primary py-1 font-bold text-void disabled:bg-line disabled:text-dim">
                <Play size={12} /> {t('START')}
              </button>
            )}
          </div>
        </Panel>
        <ForgePanel key={runsKey} />
      </div>
      <Panel title={`FORGE // ${job?.status === 'running' ? `${t('RUNNING')} ${job.run} · ${t(job.current?.toUpperCase() ?? '')}` : t((job?.status ?? 'idle').toUpperCase())}`}>
        <div className="flex h-full flex-col">
          {job?.error && <p className="border-b border-line px-3 py-1 font-mono text-[11px] text-critical">{job.error}</p>}
          <pre ref={logRef} data-testid="forge-log" className="min-h-0 flex-1 overflow-auto bg-void p-2 font-mono text-[11px] whitespace-pre-wrap text-muted select-text">
            {job?.log.length ? job.log.join('\n') : t('No output yet. Pick the steps and press START.')}
          </pre>
        </div>
      </Panel>
    </div>
  )
}
