import { useEffect, useState } from 'react'
import { Bot, Cpu, Database, Download, HardDrive, Play, Power, RefreshCw, Star, Trash2, X } from 'lucide-react'
import type { BenchResult, FitPlan, ForgeRun, LaunchProfile, ModelInfo, ModelProfile, NetworkMode, SetupItem } from '../../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useStore } from '@/app/store'
import { Panel, IconButton } from '@/components/hud/Panel'
import { useAi } from '@/app/ai-store'
import { estimateFit, formatBytes } from '@/lib/fit'
import { t as tr, useT } from '@/lib/i18n'

export function ModelVault() {
  const refresh = useAi(s => s.refresh)
  const refreshRunning = useAi(s => s.refreshRunning)

  useEffect(() => {
    void refresh()
    const t = setInterval(() => !document.hidden && void refreshRunning(true), 3000)
    return () => clearInterval(t)
  }, [refresh, refreshRunning])

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_340px] gap-2 p-2">
      <InstalledModels />
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <SetupPanel />
        <IdleUnloadPanel />
        <SourcesPanel />
        <HardwarePanel />
        <ForgePanel />
        <NetworkPanel />
        <PullPanel />
      </div>
    </div>
  )
}

function InstalledModels() {
  const status = useAi(s => s.status)
  const models = useAi(s => s.models)
  const refresh = useAi(s => s.refresh)
  const t = useT()

  return (
    <Panel
      title={`MODEL VAULT // ${t('INSTALLED')}`}
      actions={
        <IconButton title={t('Refresh')} onClick={() => void refresh()}>
          <RefreshCw size={12} />
        </IconButton>
      }
    >
      <div className="flex h-full flex-col overflow-auto">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 font-mono text-[11px]">
          <span className={`h-2 w-2 ${status?.reachable ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-critical'}`} />
          <span className="text-muted">LLAMA.CPP</span>
          <span className={status?.reachable ? 'text-success' : 'text-critical'}>
            {status ? (status.reachable ? status.version : `${t('NOT AVAILABLE')} — ${status.error}`) : t('checking')}
          </span>
          <span className="truncate text-dim" title={status?.url}>
            {status?.url}
          </span>
        </div>
        {status && !status.reachable && (
          <p className="p-4 text-[12.5px] text-muted">{t('The llama.cpp runtime is not installed. Use SETUP on the right (ONLINE TOOLS mode) to download the official build.')}</p>
        )}
        {models.length === 0 && (
          <p className="p-4 text-[12.5px] text-muted">
            {t("No GGUF models in the models folder or in LM Studio's folder. Switch to ONLINE TOOLS mode and download one on the right.")}
          </p>
        )}
        <ul className="flex flex-col gap-2 p-2">
          {models.map(m => (
            <ModelCard key={m.name} model={m} />
          ))}
        </ul>
      </div>
    </Panel>
  )
}

function ModelCard({ model }: { model: ModelInfo }) {
  const details = useAi(s => s.details[model.name])
  const running = useAi(s => s.running.find(r => r.name === model.name))
  const hardware = useAi(s => s.hardware)
  const busy = useAi(s => s.busy[model.name])
  const roles = useAi(s => s.roles)
  const { loadModel, unloadModel, deleteModel, setRole } = useAi.getState()
  const myRoles = (['general', 'agent', 'embedding'] as const).filter(r => roles[r] === model.name)
  const canAgent = details?.capabilities.includes('tools') ?? false
  const t = useT()

  const vram = hardware?.gpus[0]?.vramTotalBytes ?? 0
  const fit = hardware ? estimateFit(model.sizeBytes, vram, hardware.ramTotalBytes) : null
  const fitColor = fit?.kind === 'gpu' ? 'text-success' : fit?.kind === 'hybrid' ? 'text-primary' : 'text-critical'
  // What llama.cpp itself would do now (llama-fit-params); the size-based estimate is only a fallback.
  const [plan, setPlan] = useState<FitPlan | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void api.invoke('models:fit', model.name).then(p => alive && setPlan(p), () => alive && setPlan(null))
    return () => void (alive = false)
  }, [model.name, running?.expiresAt])

  return (
    <li data-model={model.name} className="hud-cut-sm border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[14px] font-semibold text-text" title={model.name}>
          {model.label}
        </span>
        {model.source === 'lmstudio' && (
          <span data-source-badge="lmstudio" title={t("From LM Studio's models folder; run by NETRUNNER's llama.cpp")} className="border border-secondary/50 px-1 font-mono text-[9.5px] tracking-wider text-secondary">
            LM STUDIO
          </span>
        )}
        {myRoles.map(r => (
          <span key={r} data-role-badge={r} className="font-mono text-[10px] tracking-wider text-primary">
            {r === 'general' ? t('GENERAL') : r === 'agent' ? t('AGENT') : t('MEMORY')}
          </span>
        ))}
        {running && <span className="font-mono text-[10px] tracking-wider text-success">● {running.expiresAt === 'loading' ? t('LOADING') : t('LOADED')}</span>}
        {running?.expiresAt === 'loading' && model.sizeBytes > 6 * 2 ** 30 && (
          // NSC-ME phases 1 and 3: from the Windows file cache ~8 s; from this class of SATA disk ~0.55 GB/s.
          <span className="font-mono text-[10px] text-dim">{t('from disk up to ~{n} s', { n: Math.round(model.sizeBytes / 0.55e9 + 8) })}</span>
        )}
        {busy && <span className="animate-pulse font-mono text-[10px] tracking-wider text-secondary">{busy.toUpperCase()}…</span>}
        <div className="ml-auto flex items-center gap-1">
          {model.kind === 'chat' ? (
            <>
              <IconButton title={t('Use as the general (chat) model')} onClick={() => void setRole('general', roles.general === model.name ? null : model.name)}>
                <Star size={13} className={roles.general === model.name ? 'fill-primary text-primary' : ''} />
              </IconButton>
              <IconButton title={canAgent ? t('Use as the agent model') : t('No tool calling in this model')} disabled={!canAgent} onClick={() => void setRole('agent', model.name)}>
                <Bot size={13} className={roles.agent === model.name ? 'text-primary' : ''} />
              </IconButton>
            </>
          ) : model.kind === 'reranker' ? (
            <span className="font-mono text-[10px] tracking-wider text-secondary" title={t('Used automatically to rank memory search results')}>
              {t('RERANKER')}
            </span>
          ) : (
            <IconButton title={t('Use for project memory')} onClick={() => void setRole('embedding', model.name)}>
              <Database size={13} className={roles.embedding === model.name ? 'text-primary' : ''} />
            </IconButton>
          )}
          {running ? (
            <IconButton title={t('Unload from memory')} disabled={!!busy} onClick={() => void unloadModel(model.name)}>
              <Power size={13} />
            </IconButton>
          ) : (
            <IconButton title={t('Load into memory')} disabled={!!busy} onClick={() => void loadModel(model.name)}>
              <Play size={13} />
            </IconButton>
          )}
          <IconButton
            title={model.source === 'lmstudio' ? t('Managed by LM Studio — delete it there') : t('Delete model')}
            disabled={!!busy || model.source === 'lmstudio'}
            onClick={() => void deleteModel(model.name)}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-x-4 gap-y-1 font-mono text-[11px]">
        <Field k={t('SIZE')} v={formatBytes(model.sizeBytes)} />
        <Field k={t('PARAMS')} v={model.parameterSize ?? '—'} />
        <Field k="QUANT" v={model.quantization ?? '—'} />
        <Field k="ARCH" v={details?.architecture ?? model.family ?? '—'} />
        <Field k="MAX CTX" v={details?.contextLength ? details.contextLength.toLocaleString() : '—'} />
        <Field k={t('CAPS')} v={details ? [...details.capabilities, ...(details.parameters ? [details.parameters] : [])].join(' · ') || '—' : '…'} wide />
      </div>
      <div className="mt-2 flex items-center gap-4 font-mono text-[11px]">
        {plan ? (
          <span data-fit-plan={`${plan.gpuLayers}/${plan.totalLayers}/${plan.cpuExpertLayers}`} className={plan.gpuLayers >= plan.totalLayers && !plan.cpuExpertLayers ? 'text-success' : 'text-primary'}>
            {plan.gpuLayers >= plan.totalLayers && !plan.cpuExpertLayers
              ? t('llama.cpp plan: all {n} layers on the GPU', { n: plan.totalLayers })
              : plan.gpuLayers >= plan.totalLayers
                ? t('llama.cpp plan: all layers on the GPU, MoE experts of {k} of {n} layers in RAM', { k: plan.cpuExpertLayers, n: plan.totalLayers })
                : t('llama.cpp plan: {g} of {n} layers on the GPU, the rest in RAM', { g: plan.gpuLayers, n: plan.totalLayers })}
            {` · ctx ${plan.ctx.toLocaleString()}`}
          </span>
        ) : (
          fit && <span className={fitColor}>{plan === undefined ? '' : `${t('estimate')}: `}{fit.kind === 'hybrid' ? t('GPU+CPU offload (~{p}% on GPU)', { p: Math.round(fit.gpuShare * 100) }) : t(fit.label)}</span>
        )}
        {running && (
          <span className="text-secondary">
            {t('measured')}: {running.sizeVramBytes ? formatBytes(running.sizeVramBytes) : '—'} VRAM / {formatBytes(running.sizeBytes)} {t('weights')}
            {running.contextLength ? ` · ctx ${running.contextLength.toLocaleString()}` : ''}
          </span>
        )}
      </div>
      {model.kind === 'chat' && <Autotune model={model.name} />}
      {model.kind === 'chat' && details?.experts && <FastMode model={model.name} experts={details.experts} loaded={!!running} />}
      {model.kind === 'chat' && details?.experts && <VramSaver model={model.name} loaded={!!running} />}
    </li>
  )
}

const profileText = (p: LaunchProfile, t: ReturnType<typeof useT>) =>
  Object.keys(p).length
    ? [p.threads ? t('{n} CPU threads', { n: p.threads }) : null, p.ubatch ? `ubatch ${p.ubatch}` : null, p.mtp === undefined ? null : p.mtp ? 'MTP' : t('no MTP'), p.moeCacheMib ? t('expert cache {n} GB', { n: p.moeCacheMib / 1024 }) : null].filter(Boolean).join(' · ')
    : t('defaults')
const benchText = (r: BenchResult | null) => (r ? `${r.genTokPerS} tok/s · prompt ${Math.round(r.promptTokPerS)} tok/s` : '—')

/**
 * NSC stage 3: measure other llama-server settings for this model, keep the faster ones (beyond the noise), and
 * show what is applied. A profile is reverted by itself when real runs afterwards are clearly slower.
 */
function Autotune({ model }: { model: string }) {
  const t = useT()
  const [profile, setProfile] = useState<ModelProfile | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; last: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.invoke('autotune:get', model).then(setProfile, () => undefined)
    return api.on('autotune:event', e => {
      if (e.model !== model) return
      if (e.type === 'start') setProgress({ done: 0, total: e.candidates, last: '' })
      else if (e.type === 'measured') setProgress(p => ({ done: (p?.done ?? 0) + 1, total: p?.total ?? 0, last: `${profileText(e.profile, t)}: ${e.result ? benchText(e.result) : e.error}${e.kept ? ' ✓' : ''}` }))
      else if (e.type === 'done' || e.type === 'reverted') {
        setProfile(e.profile)
        setProgress(null)
      } else if (e.type === 'error') {
        setError(e.message)
        setProgress(null)
      }
    })
  }, [model, t])
  const run = () => {
    setError(null)
    api.invoke('autotune:run', model).catch(err => setError(errorMessage(err)))
  }
  const reset = () => void api.invoke('autotune:reset', model).then(() => setProfile(null))
  return (
    <div data-autotune={model} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 font-mono text-[11px]">
      <span className="text-dim">{t('TUNING')}</span>
      {progress ? (
        <span className="animate-pulse text-secondary">
          {t('measuring {done}/{total}', { done: progress.done, total: progress.total })} {progress.last && `· ${progress.last}`}
        </span>
      ) : profile ? (
        <span data-autotune-status={profile.status} className={profile.status === 'reverted' ? 'text-critical' : 'text-success'} title={profile.note ?? undefined}>
          {profile.status === 'reverted' ? t('reverted to defaults') : profileText(profile.profile, t)} · {benchText(profile.chosen)}
          {Object.keys(profile.profile).length > 0 && profile.status === 'active' && ` (${t('defaults')}: ${benchText(profile.defaults)})`}
        </span>
      ) : (
        <span className="text-muted">{t('defaults, not measured')}</span>
      )}
      {error && <span className="text-critical">{error}</span>}
      <span className="ml-auto flex gap-2">
        <button data-testid="autotune-run" disabled={!!progress} onClick={run} className="border border-line px-2 text-muted hover:text-primary disabled:opacity-40" title={t('Measures several llama.cpp settings for this model (reloads it several times, a few minutes) and keeps only real gains')}>
          {t('TUNE')}
        </button>
        {profile && (
          <button disabled={!!progress} onClick={reset} className="border border-line px-2 text-muted hover:text-critical disabled:opacity-40">
            {t('RESET')}
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * NSC stage 6: fast mode of a MoE model — fewer experts per token than it was trained with (a fifth fewer).
 * Measured on Qwen3-Coder-Next, 10 → 8: +19% generation, MMLU / GSM8K / HumanEval within noise; 6 and 4 lose quality.
 */
function FastMode({ model, experts, loaded }: { model: string; experts: { total: number; used: number }; loaded: boolean }) {
  const t = useT()
  const [value, setValue] = useState<number | null | undefined>(undefined)
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    void api.invoke('settings:get').then(s => setValue(s.fastExperts[model] ?? null), () => undefined)
  }, [model])
  const fast = Math.max(1, Math.round(experts.used * 0.8))
  if (value === undefined || fast >= experts.used) return null
  const toggle = () =>
    void api.invoke('settings:set-fast-experts', model, value ? null : fast).then(s => {
      setValue(s.fastExperts[model] ?? null)
      setChanged(true)
    })
  return (
    <div data-fast-mode={model} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 font-mono text-[11px]">
      <span className="text-dim">{t('FAST MODE')}</span>
      <span data-fast-mode-state={value ? 'on' : 'off'} className={value ? 'text-primary' : 'text-muted'}>
        {value ? t('{k} of {n} experts per token', { k: value, n: experts.used }) : t('off · {n} experts per token, as trained', { n: experts.used })}
      </span>
      {changed && loaded && <span className="text-secondary">{t('applies at the next model load')}</span>}
      <button
        data-testid="fast-mode-toggle"
        onClick={toggle}
        className="ml-auto border border-line px-2 text-muted hover:text-primary"
        title={t('Fewer MoE experts per token: faster generation, answers may get slightly worse. Measured on Qwen3-Coder-Next, 10 → 8 experts: +19% speed, benchmark scores within noise.')}
      >
        {value ? t('TURN OFF') : t('TURN ON')}
      </button>
    </div>
  )
}

/**
 * NSC-ME phase 6: VRAM saver of a MoE model — all experts in RAM (--cpu-moe). Measured on Qwen3-Coder-Next: 10.2 → 4.8 GB
 * of VRAM at −9% generation, and full speed next to a program that takes 3–6 GB of VRAM (2× slower without it).
 */
export function VramSaver({ model, loaded }: { model: string; loaded: boolean }) {
  const t = useT()
  const [on, setOn] = useState<boolean | undefined>(undefined)
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    void api.invoke('settings:get').then(s => setOn(s.vramSaver.includes(model)), () => undefined)
  }, [model])
  if (on === undefined) return null
  const toggle = () =>
    void api.invoke('settings:set-vram-saver', model, !on).then(s => {
      setOn(s.vramSaver.includes(model))
      setChanged(true)
    })
  return (
    <div data-vram-saver={model} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 font-mono text-[11px]">
      <span className="text-dim">{t('VRAM SAVER')}</span>
      <span data-vram-saver-state={on ? 'on' : 'off'} className={on ? 'text-primary' : 'text-muted'}>
        {on ? t('on · all experts in RAM') : t('off')}
      </span>
      {changed && loaded && <span className="text-secondary">{t('applies at the next model load')}</span>}
      <button
        data-testid="vram-saver-toggle"
        onClick={toggle}
        className="ml-auto border border-line px-2 text-muted hover:text-primary"
        title={t('All MoE experts stay in RAM: about 5 GB less VRAM for other programs, generation about 9% slower. Measured on Qwen3-Coder-Next: with it the model keeps its speed when another program takes 3–6 GB of VRAM; without it, 2× slower.')}
      >
        {on ? t('TURN OFF') : t('TURN ON')}
      </button>
    </div>
  )
}

function Field({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 gap-2 ${wide ? 'col-span-3' : ''}`}>
      <span className="text-dim">{k}</span>
      <span className="truncate text-text">{v}</span>
    </div>
  )
}

function Meter({ label, used, total, color }: { label: string; used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between font-mono text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="text-text">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="h-1.5 bg-line">
        <div className={`h-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function HardwarePanel() {
  const hw = useAi(s => s.hardware)
  const t = useT()
  return (
    <Panel title={t('HARDWARE')} accent="secondary" fit>
      {hw ? (
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
            <Cpu size={13} className="text-secondary" />
            <span className="truncate">{hw.cpuModel}</span>
            <span className="ml-auto text-text">{hw.cpuThreads} {t('thr')}</span>
          </div>
          <Meter label="RAM" used={hw.ramTotalBytes - hw.ramFreeBytes} total={hw.ramTotalBytes} color="bg-secondary" />
          {hw.gpus.map(g => (
            <div key={g.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                <HardDrive size={13} className="text-primary" />
                <span className="truncate">{g.name}</span>
                <span className="ml-auto text-text">{g.utilizationPct ?? '—'}%</span>
              </div>
              <Meter label="VRAM" used={g.vramUsedBytes} total={g.vramTotalBytes} color="bg-primary" />
            </div>
          ))}
          {hw.gpuError && <p className="font-mono text-[11px] text-critical">{hw.gpuError}</p>}
        </div>
      ) : (
        <p className="p-3 font-mono text-[11px] text-dim">{t('reading…')}</p>
      )}
    </Panel>
  )
}

/** First-run checklist: what NETRUNNER needs, what is missing, and a one-click fix where one exists. */
function SetupPanel() {
  const [items, setItems] = useState<SetupItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const online = useAi(s => s.settings?.networkMode === 'online-tools')
  const pull = useAi(s => s.pull)
  const load = () => void api.invoke('setup:check').then(setItems, () => setItems([]))
  const t = useT()
  useEffect(load, [])

  const fix = async (item: SetupItem) => {
    if (!item.fix) return
    setBusy(item.id)
    try {
      if (item.fix.kind === 'pull') await pull(item.fix.model)
      else if (item.fix.kind === 'install-ripgrep') {
        const version = await api.invoke('setup:install-ripgrep')
        useStore.getState().notify('success', `${tr('installed')} ${version} — ${tr('restart the agent engine to use it')}`)
      } else {
        const dir = await api.invoke('setup:install-runtime')
        useStore.getState().notify('success', `llama.cpp ${tr('installed')}: ${dir}`)
        await useAi.getState().refresh()
      }
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    } finally {
      setBusy(null)
      load()
    }
  }

  const missing = items?.filter(i => !i.ok).length ?? 0
  return (
    <Panel
      title={`${t('SETUP')}${items ? (missing ? ` // ${t('{n} TO DO', { n: missing })}` : ` // ${t('READY')}`) : ''}`}
      accent={missing ? 'primary' : 'secondary'}
      fit
      actions={
        <IconButton title={t('Re-check')} onClick={load}>
          <RefreshCw size={12} />
        </IconButton>
      }
    >
      <ul data-testid="setup-checklist" className="flex flex-col gap-1.5 p-3 font-mono text-[11px]">
        {!items && <li className="text-dim">{t('checking…')}</li>}
        {items?.map(i => (
          <li key={i.id} data-setup={i.id} data-ok={i.ok} className="flex gap-2">
            <span className={i.ok ? 'text-success' : i.required ? 'text-critical' : 'text-primary'}>{i.ok ? '✓' : i.required ? '✕' : '!'}</span>
            <div className="flex min-w-0 flex-col">
              <span className={i.ok ? 'text-text' : 'text-muted'}>{t(i.label)}</span>
              <span className="text-[10.5px] break-words text-dim">{t(i.detail)}</span>
              {i.fix && (
                <button
                  disabled={busy !== null || !online}
                  title={!online ? t('Downloads need ONLINE TOOLS mode') : undefined}
                  onClick={() => void fix(i)}
                  className="mt-0.5 w-fit border border-primary px-2 text-[10px] text-primary disabled:border-line disabled:text-dim"
                >
                  {busy === i.id ? t('WORKING…') : i.fix.kind === 'pull' ? `${t('DOWNLOAD')} ${i.fix.model}` : i.fix.kind === 'install-ripgrep' ? t('INSTALL ripgrep (GitHub release)') : t('INSTALL llama.cpp (GitHub release)')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <RuntimeUpdate online={online} />
    </Panel>
  )
}

/** llama.cpp updates: checked on demand (ONLINE TOOLS); the install verifies every archive's published SHA-256. */
function RuntimeUpdate({ online }: { online: boolean }) {
  const [info, setInfo] = useState<{ installed: string | null; latest: string; newer: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useT()
  const run = async (install: boolean) => {
    setBusy(true)
    try {
      if (install) {
        const dir = await api.invoke('setup:install-runtime')
        useStore.getState().notify('success', `llama.cpp ${tr('installed')}: ${dir} — ${tr('models use it from their next start')}`)
        await useAi.getState().refresh()
      }
      setInfo(await api.invoke('runtime:check-update'))
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="runtime-update" className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 font-mono text-[11px] text-muted">
      <span>llama.cpp {info?.installed ?? ''}</span>
      {info && (info.newer ? <span className="text-primary">{t('{tag} available', { tag: info.latest })}</span> : <span className="text-success">{t('up to date')}</span>)}
      <button
        disabled={!online || busy}
        title={online ? '' : t('Needs ONLINE TOOLS network mode')}
        onClick={() => void run(false)}
        className="border border-line px-2 py-0.5 text-text hover:border-secondary disabled:opacity-40"
      >
        {t('CHECK FOR UPDATES')}
      </button>
      {info?.newer && (
        <button disabled={busy} onClick={() => void run(true)} className="border border-primary px-2 py-0.5 text-primary disabled:opacity-40">
          {t('INSTALL {tag}', { tag: info.latest })}
        </button>
      )}
    </div>
  )
}

/** Where models come from: NETRUNNER's folder and LM Studio's downloads (read in place, never modified). */
const IDLE_CHOICES = [0, 5, 10, 30, 60, 120]

/**
 * NSC-ME phase 3: models nobody used for a while are unloaded and give all their RAM and VRAM back. Small ones come
 * back in seconds; a large one in ~8 s while Windows still caches its file, up to ~100 s from a SATA disk.
 * Chat conversations are saved first and restored at the next load (phase 4).
 */
export function IdleUnloadPanel() {
  const t = useT()
  const [v, setV] = useState<{ smallMinutes: number; largeMinutes: number } | null>(null)
  useEffect(() => {
    void api.invoke('settings:get').then(s => setV(s.idleUnload), () => undefined)
  }, [])
  if (!v) return null
  const set = (next: { smallMinutes: number; largeMinutes: number }) => void api.invoke('settings:set-idle-unload', next.smallMinutes, next.largeMinutes).then(s => setV(s.idleUnload))
  const label = (m: number) => (m ? t('{n} min', { n: m }) : t('never'))
  const row = (key: 'smallMinutes' | 'largeMinutes', title: string, hint: string) => (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="text-text">{title}</span>
        <select data-testid={`idle-${key}`} value={v[key]} onChange={e => set({ ...v, [key]: Number(e.target.value) })} className="ml-auto border border-line bg-surface-2 px-1 text-text">
          {IDLE_CHOICES.map(m => (
            <option key={m} value={m}>
              {label(m)}
            </option>
          ))}
        </select>
      </span>
      <span className="text-[10.5px] text-dim">{hint}</span>
    </label>
  )
  return (
    <Panel title={t('IDLE MODELS')} accent="secondary" fit>
      <div data-testid="idle-unload" className="flex flex-col gap-2 p-3 font-mono text-[11px]">
        {row('smallMinutes', t('Small (≤ 6 GB): unload after'), t('Back in a few seconds, even from disk.'))}
        {row('largeMinutes', t('Large: unload after'), t('Back in ~8 s while Windows caches the file; from a SATA disk up to ~100 s.'))}
        <span className="text-[10.5px] text-dim">{t('Any idle model is unloaded when RAM runs out. Chat conversations are saved and restored at the next load. The agent model is never unloaded while agents run.')}</span>
      </div>
    </Panel>
  )
}

function SourcesPanel() {
  const sources = useAi(s => s.sources)
  const setLmStudioDir = useAi(s => s.setLmStudioDir)
  const lm = sources.find(s => s.source === 'lmstudio')
  const own = sources.find(s => s.source === 'netrunner')
  const t = useT()
  return (
    <Panel title={t('MODEL SOURCES')} accent="secondary" fit>
      <div data-testid="model-sources" className="flex flex-col gap-2 p-3 font-mono text-[11px]">
        <div className="flex flex-col">
          <span className="text-text">
            NETRUNNER <span className="text-dim">· {own?.models ?? 0} {t('models')}</span>
          </span>
          <span className="text-[10.5px] break-all text-dim">{own?.dir ?? '…'}</span>
        </div>
        <div data-source="lmstudio" data-found={!!lm?.dir} className="flex flex-col">
          <span className="text-text">
            LM STUDIO{' '}
            <span className={lm?.dir ? 'text-dim' : 'text-primary'}>
              · {lm?.dir ? `${lm.models} ${t('models')} · ${lm.manual ? t('chosen folder') : t('detected')}` : lm?.manual ? t('chosen folder missing') : t('not found')}
            </span>
          </span>
          <span className="text-[10.5px] break-all text-dim">{lm?.dir ?? t('Install LM Studio or choose its models folder.')}</span>
          <span className="text-[10.5px] text-dim">{t("Files are read in place and run by NETRUNNER's llama.cpp; LM Studio itself is not started.")}</span>
          <div className="mt-1 flex gap-1">
            <button onClick={() => void setLmStudioDir('pick')} className="border border-secondary px-2 text-[10px] text-secondary hover:bg-secondary/10">
              {t('CHOOSE FOLDER')}
            </button>
            {lm?.manual && (
              <button onClick={() => void setLmStudioDir('auto')} className="border border-line px-2 text-[10px] text-muted hover:text-text">
                {t('AUTO-DETECT')}
              </button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

export function ForgePanel() {
  const [runs, setRuns] = useState<ForgeRun[] | null>(null)
  useEffect(() => {
    void api.invoke('forge:runs').then(setRuns, () => setRuns([]))
  }, [])
  const t = useT()
  return (
    <Panel title={`FORGE // ${t('FINE-TUNED')}`} accent="secondary" fit>
      <div data-testid="forge-runs" className="flex flex-col gap-2 p-3 font-mono text-[11px]">
        {runs === null && <span className="text-dim">{t('reading…')}</span>}
        {runs?.length === 0 && <span className="text-dim">{t('No training runs yet.')}</span>}
        {runs?.map(r => (
          <div key={r.name} className="flex flex-col gap-0.5 border-l-2 border-secondary/50 pl-2">
            <span className="text-text">
              {r.name}
              {r.exportedModel && <span className="text-secondary"> → {r.exportedModel.split('/').pop()!}</span>}
            </span>
            {r.dataset && (
              <span className="text-muted">
                {t('data')}: {r.dataset.trainSamples} train / {r.dataset.evalSamples} eval · {t('teacher')} {r.dataset.teacher}
              </span>
            )}
            {r.training ? (
              <span className="text-muted">
                eval loss <span className="text-text">{r.training.evalLossBefore.toFixed(3)}</span> →{' '}
                <span className="text-success">{r.training.evalLossAfter.toFixed(3)}</span> · {Math.round(r.training.trainSeconds)} s ·{' '}
                {r.training.peakVramGb.toFixed(1)} GB VRAM
              </span>
            ) : (
              <span className="text-dim">{t('not trained yet')}</span>
            )}
            {r.evaluation && (
              <span className="text-muted">
                {t('judge')} {r.evaluation.baseJudgeMean.toFixed(1)} → <span className="text-success">{r.evaluation.tunedJudgeMean.toFixed(1)}</span>/10 ·{' '}
                {t('wins')} {r.evaluation.tunedWins}/{r.evaluation.ties}/{r.evaluation.baseWins}
              </span>
            )}
            {r.bench && (
              <span data-testid="forge-bench" className="text-muted">
                {r.bench.suites.map(s => (
                  <span key={s.suite} className="mr-2">
                    {s.suite.toUpperCase()} {s.base.toFixed(1)} → <span className={s.tuned >= s.base ? 'text-success' : 'text-critical'}>{s.tuned.toFixed(1)}</span>%
                  </span>
                ))}
              </span>
            )}
          </div>
        ))}
      </div>
    </Panel>
  )
}

const MODES: { id: NetworkMode; label: string; hint: string }[] = [
  { id: 'strict-offline', label: 'STRICT OFFLINE', hint: 'Loopback runtime only. Downloads refused.' },
  { id: 'local-network', label: 'LOCAL NETWORK', hint: 'Runtimes on private LAN addresses allowed.' },
  { id: 'online-tools', label: 'ONLINE TOOLS', hint: 'Model downloads allowed. Inference stays local.' },
]

export function NetworkPanel() {
  const mode = useAi(s => s.settings?.networkMode)
  const setNetworkMode = useAi(s => s.setNetworkMode)
  const t = useT()
  return (
    <Panel title={t('NETWORK MODE')} fit>
      <div className="flex flex-col gap-1 p-2">
        {MODES.map(m => (
          <button
            key={m.id}
            data-network-mode={m.id}
            onClick={() => void setNetworkMode(m.id)}
            className={`flex flex-col items-start px-3 py-1.5 text-left ${
              mode === m.id ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <span className="font-mono text-[11.5px] font-semibold tracking-wider">
              {mode === m.id ? '▸ ' : ''}
              {t(m.label)}
            </span>
            <span className={`text-[11px] ${mode === m.id ? 'text-muted' : 'text-dim'}`}>{t(m.hint)}</span>
          </button>
        ))}
      </div>
    </Panel>
  )
}

function PullPanel() {
  const [name, setName] = useState('')
  const online = useAi(s => s.settings?.networkMode === 'online-tools')
  const allPulls = useAi(s => s.pulls)
  const pulls = Object.values(allPulls).filter(p => !p.done)
  const pull = useAi(s => s.pull)
  const cancelPull = useAi(s => s.cancelPull)
  const t = useT()

  return (
    <Panel title={t('DOWNLOAD MODEL')} className="flex-1">
      <div className="flex flex-col gap-2 p-3">
        <form
          className="flex gap-1"
          onSubmit={e => {
            e.preventDefault()
            if (name.trim()) void pull(name.trim())
          }}
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('owner/repo:QUANT, e.g. Qwen/Qwen3-Coder-Next-GGUF:Q4_K_M')}
            className="min-w-0 flex-1 border border-line bg-void px-2 py-1 font-mono text-[12px] text-text outline-none placeholder:text-dim focus:border-secondary"
          />
          <button
            disabled={!online || !name.trim()}
            title={online ? t('Download GGUF files from Hugging Face (resumable)') : t('Needs ONLINE TOOLS mode')}
            className="hud-cut-sm flex items-center gap-1 bg-primary px-3 font-mono text-[11px] font-bold text-void disabled:bg-line disabled:text-dim"
          >
            <Download size={12} /> {t('PULL')}
          </button>
        </form>
        {!online && <p className="text-[11px] text-dim">{t('Downloads are disabled outside ONLINE TOOLS mode.')}</p>}
        {pulls.map(p => (
          <div key={p.pullId} className="flex flex-col gap-1 font-mono text-[11px]">
            <div className="flex items-center gap-2">
              <span className="truncate text-text">{p.model}</span>
              <span className="text-muted">{p.status}</span>
              <IconButton title={t('Cancel')} onClick={() => void cancelPull(p.pullId)}>
                <X size={12} />
              </IconButton>
            </div>
            {p.totalBytes ? (
              <div className="h-1 bg-line">
                <div className="h-full bg-secondary" style={{ width: `${((p.completedBytes ?? 0) / p.totalBytes) * 100}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  )
}
