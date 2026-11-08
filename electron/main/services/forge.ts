import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ForgeEnv, ForgeJob, ForgeRun, ForgeStartRequest, ForgeStep } from '../../shared/ipc'

/** Same default as forge/common.py. */
export function forgeHome(): string {
  return process.env.NETRUNNER_FORGE_HOME ?? path.join(os.homedir(), 'NETRUNNER', 'forge')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')) as T
  } catch {
    return null
  }
}

/** bench_report.json summary → base/tuned percent per suite (the first model is the base, the second the tuned one). */
function benchSummary(s: Record<string, unknown> | undefined): ForgeRun['bench'] {
  const models = Array.isArray(s?.models) ? (s.models as string[]) : []
  if (!s || models.length < 2) return null
  const [baseModel, tunedModel] = models
  const suites = ['mmlu', 'gsm8k', 'humaneval'].flatMap(suite => {
    const v = s[suite] as Record<string, number> | undefined
    return v && typeof v[baseModel] === 'number' && typeof v[tunedModel] === 'number' ? [{ suite, n: Number(s[`${suite}_n`]), base: v[baseModel], tuned: v[tunedModel] }] : []
  })
  return { baseModel, tunedModel, suites }
}

/** Reads the reports written by the FORGE pipeline. Read-only; nothing is computed or assumed here. */
export async function listForgeRuns(home = forgeHome()): Promise<ForgeRun[]> {
  const runsDir = path.join(home, 'runs')
  const names = await fs.readdir(runsDir).catch(() => [] as string[])
  const runs = await Promise.all(
    names.map(async (name): Promise<ForgeRun | null> => {
      const dir = path.join(runsDir, name)
      if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) return null
      const ds = await readJson<Record<string, number | string>>(path.join(dir, 'dataset_stats.json'))
      const tr = await readJson<Record<string, number | string>>(path.join(dir, 'train_report.json'))
      const ev = await readJson<{ summary: Record<string, number | string> }>(path.join(dir, 'eval_report.json'))
      const bench = await readJson<{ summary: Record<string, unknown> }>(path.join(dir, 'bench_report.json'))
      const exported = (await fs.readFile(path.join(dir, 'exported_model.txt'), 'utf8').catch(() => null)) ?? (await fs.readFile(path.join(dir, 'ollama_model.txt'), 'utf8').catch(() => null))
      return {
        name,
        dir,
        dataset: ds && {
          trainSamples: Number(ds.train_samples),
          evalSamples: Number(ds.eval_samples),
          teacher: String(ds.teacher),
          workspace: String(ds.workspace),
          chunks: Number(ds.chunks),
        },
        training: tr && {
          base: String(tr.base),
          epochs: Number(tr.epochs),
          loraRank: Number(tr.lora_rank),
          evalLossBefore: Number(tr.eval_loss_before),
          evalLossAfter: Number(tr.eval_loss_after),
          trainSeconds: Number(tr.train_seconds),
          peakVramGb: Number(tr.peak_vram_gb),
        },
        evaluation: ev && {
          baseModel: String(ev.summary.base_model),
          tunedModel: String(ev.summary.tuned_model),
          judgeModel: String(ev.summary.judge_model),
          questions: Number(ev.summary.questions),
          baseJudgeMean: Number(ev.summary.base_judge_mean),
          tunedJudgeMean: Number(ev.summary.tuned_judge_mean),
          tunedWins: Number(ev.summary.tuned_wins),
          ties: Number(ev.summary.ties),
          baseWins: Number(ev.summary.base_wins),
        },
        bench: benchSummary(bench?.summary),
        exportedModel: exported?.trim() || null,
      }
    }),
  )
  return runs.filter((r): r is ForgeRun => r !== null).sort((a, b) => a.name.localeCompare(b.name))
}

/** Untouched base exported once for the before/after comparison. */
export const BASE_EXPORT = 'qwen3.5-4b-base'
const STEPS: ForgeStep[] = ['setup', 'dataset', 'train', 'merge', 'export', 'export-base', 'evaluate', 'bench']
const RUN_RE = /^[\w.-]{1,40}$/

/** Command line of one pipeline step (the scripts live in `scriptsDir`). */
export function forgeCommand(step: ForgeStep, req: ForgeStartRequest, scriptsDir: string): string[] {
  const s = (name: string) => path.join(scriptsDir, name)
  const name = req.exportName || `netrunner-${req.run}`
  switch (step) {
    case 'setup':
      return [s('setup_env.py')]
    case 'dataset':
      return [s('build_dataset.py'), '--workspace', req.workspace, '--run', req.run, ...(req.maxChunks ? ['--max-chunks', String(req.maxChunks)] : [])]
    case 'train':
      return [s('train_qlora.py'), '--run', req.run, ...(req.epochs ? ['--epochs', String(req.epochs)] : [])]
    case 'merge':
      return [s('merge_lora.py'), '--run', req.run]
    case 'export':
      return [s('export_gguf.py'), '--run', req.run, '--name', name]
    case 'export-base':
      return [s('export_gguf.py'), '--run', req.run, '--name', BASE_EXPORT, '--source', 'base']
    case 'evaluate':
      return [s('evaluate.py'), '--run', req.run, '--base', BASE_EXPORT, '--tuned', name]
    case 'bench':
      return [s('bench.py'), '--run', req.run, '--models', BASE_EXPORT, name]
  }
}

export function validateForgeRequest(req: ForgeStartRequest): ForgeStartRequest {
  if (!RUN_RE.test(String(req?.run))) throw new Error('Run name: letters, digits, . _ - (up to 40)')
  const steps = Array.isArray(req.steps) ? req.steps.filter(s => STEPS.includes(s)) : []
  if (!steps.length) throw new Error('Choose at least one step')
  if (req.exportName && !RUN_RE.test(req.exportName)) throw new Error('Export name: letters, digits, . _ - (up to 40)')
  const n = (v: unknown, max: number) => (v === undefined || v === null || v === 0 ? undefined : Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Number(v) : NaN)
  const maxChunks = n(req.maxChunks, 100000)
  const epochs = n(req.epochs, 20)
  if (Number.isNaN(maxChunks) || Number.isNaN(epochs)) throw new Error('Invalid number')
  // Keep the canonical order whatever the request says.
  return { run: req.run, steps: STEPS.filter(s => steps.includes(s)), workspace: String(req.workspace ?? ''), maxChunks, epochs, exportName: req.exportName || undefined }
}

interface ForgeDeps {
  home: string
  scriptsDir: string
  /** Free the GPU and RAM: FORGE loads its own teacher/judge models and trains on the GPU. */
  prepare: () => Promise<void>
  /** Network policy: setup downloads (ONLINE TOOLS only); every other step runs offline. */
  assertOnline: () => void
  proxyEnv: () => Promise<Record<string, string>>
  emit: (job: ForgeJob, line: string | null) => void
}

/**
 * Runs FORGE steps from the UI, one job at a time, each step a Python process; output streams to the renderer and
 * into runs/<run>/forge-ui.log. Cancelling kills the whole process tree (llama-server children included).
 */
export class ForgeService {
  private proc: ChildProcess | null = null
  private job: ForgeJob = { status: 'idle', run: null, steps: [], current: null, startedAt: null, finishedAt: null, error: null, log: [] }
  private cancelled = false

  constructor(private readonly deps: ForgeDeps) {}

  get state(): ForgeJob {
    return { ...this.job, log: this.job.log.slice(-400) }
  }

  python(venv: 'venv' | 'convert-venv' = 'venv'): string {
    return path.join(this.deps.home, venv, 'Scripts', 'python.exe')
  }

  /** What the pipeline needs, checked on disk. */
  async env(systemPython: string | null): Promise<ForgeEnv> {
    const h = this.deps.home
    const hub = path.join(h, 'hf', 'hub', 'models--unsloth--Qwen3.5-4B')
    return {
      home: h,
      systemPython,
      venv: existsSync(this.python('venv')),
      convertVenv: existsSync(this.python('convert-venv')),
      converter: existsSync(path.join(h, 'llama.cpp', 'convert_hf_to_gguf.py')),
      quantize: existsSync(path.join(h, 'llama-bin', 'llama-quantize.exe')),
      baseWeights: existsSync(hub),
      scripts: existsSync(path.join(this.deps.scriptsDir, 'train_qlora.py')),
    }
  }

  private push(line: string): void {
    this.job.log.push(line)
    if (this.job.log.length > 2000) this.job.log.splice(0, this.job.log.length - 2000)
    this.deps.emit(this.state, line)
  }

  private set(partial: Partial<ForgeJob>): void {
    this.job = { ...this.job, ...partial }
    this.deps.emit(this.state, null)
  }

  async start(raw: ForgeStartRequest, systemPython: string | null): Promise<ForgeJob> {
    if (this.job.status === 'running') throw new Error('A FORGE job is already running')
    const req = validateForgeRequest(raw)
    if (req.steps.includes('dataset') && !req.workspace) throw new Error('Open a workspace: the dataset is built from its code')
    if (req.steps.includes('setup')) {
      this.deps.assertOnline()
      if (!systemPython) throw new Error('Python 3.13 was not found (py -3.13 / python on PATH)')
    } else if (!existsSync(this.python())) throw new Error('FORGE environment missing: run SETUP first')
    await this.deps.prepare()
    this.cancelled = false
    this.job = { status: 'running', run: req.run, steps: req.steps, current: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [] }
    this.deps.emit(this.state, null)
    const logFile = path.join(this.deps.home, 'runs', req.run, 'forge-ui.log')
    void (async () => {
      try {
        for (const step of req.steps) {
          if (this.cancelled) break
          this.set({ current: step })
          this.push(`=== ${step} ===`)
          const exe = step === 'setup' ? systemPython! : this.python()
          await this.runStep(exe, forgeCommand(step, req, this.deps.scriptsDir), step === 'setup')
        }
        this.set({ status: this.cancelled ? 'cancelled' : 'done', current: null, finishedAt: new Date().toISOString() })
      } catch (err) {
        this.set({ status: this.cancelled ? 'cancelled' : 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() })
      } finally {
        this.proc = null
        await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => undefined)
        await fs.appendFile(logFile, `${this.job.log.join('\n')}\n`, 'utf8').catch(() => undefined)
      }
    })()
    return this.state
  }

  private async runStep(exe: string, args: string[], online: boolean): Promise<void> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(await this.deps.proxyEnv()),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      NETRUNNER_FORGE_HOME: this.deps.home,
      UNSLOTH_DISABLE_STATISTICS: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    }
    if (!online) env.HF_HUB_OFFLINE = '1'
    await new Promise<void>((resolve, reject) => {
      const p = spawn(exe, ['-u', ...args], { cwd: this.deps.scriptsDir, env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.proc = p
      let partial = ''
      const onData = (d: Buffer) => {
        // Progress bars redraw with \r: keep only the last state of each line.
        const text = partial + d.toString('utf8')
        const lines = text.split(/\r?\n/)
        partial = lines.pop() ?? ''
        for (const l of lines) {
          const last = l.split('\r').filter(Boolean).pop()
          if (last) this.push(last)
        }
      }
      p.stdout?.on('data', onData)
      p.stderr?.on('data', onData)
      p.once('error', reject)
      p.once('exit', code => {
        if (partial.trim()) this.push(partial.split('\r').pop()!)
        if (code === 0) resolve()
        else reject(new Error(`${path.basename(args[0])} exited with code ${code}`))
      })
    })
  }

  async cancel(): Promise<ForgeJob> {
    this.cancelled = true
    const p = this.proc
    if (p?.pid && p.exitCode === null) {
      await new Promise<void>(r => execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => r()))
    }
    return this.state
  }
}
