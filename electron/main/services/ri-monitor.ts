import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { RiFinding, RiResource, RiState } from '../../shared/ri'
import { cpuUsage } from './telemetry'

const run = promisify(execFile)
const GiB = 2 ** 30

/**
 * Thresholds, from the stage 2 measurements on Coder-Next (docs/NSC-STAGE2.md): others at 36% and 59% of the CPU
 * cost nothing, at 81% generation was 39% slower; 3 GB and even 1.2 GB of free RAM cost nothing; a second model
 * filling the VRAM made prompt reading 15% slower.
 */
export const RI_LIMITS = {
  /** Available RAM (GiB) below the lowest level measured without a slowdown (1.2 GB), weights in RAM. */
  ramLowGiB: 1,
  /** VRAM taken by others since the model was placed (GiB), with the card nearly full. */
  vramOthersGrowthGiB: 1,
  vramFullPct: 95,
  /** CPU taken by others (% of all logical CPUs) while model weights live in RAM: between 59% (no effect) and 81%. */
  cpuOthersWarnPct: 70,
  cpuOthersCriticalPct: 80,
  /** A run slower than this share of the model's usual speed. */
  speedDropRatio: 0.7,
}

export interface RiSnapshot {
  time: number
  weightsInRam: boolean
  cpuPct: number
  ownCpuPct: number | null
  ramAvailableBytes: number
  ramTotalBytes: number
  ownRamBytes: number | null
  vramUsedBytes: number | null
  vramTotalBytes: number | null
  ownVramBytes: number
  othersVramAtLoadBytes: number | null
  gpuPct: number | null
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

/** The findings of one snapshot (without `since`, which the monitor keeps across snapshots). */
export function assessInterference(s: RiSnapshot, L = RI_LIMITS): Omit<RiFinding, 'since'>[] {
  const out: Omit<RiFinding, 'since'>[] = []
  const availGiB = Math.round((s.ramAvailableBytes / GiB) * 10) / 10
  if (s.weightsInRam && availGiB < L.ramLowGiB) out.push({ kind: 'ram-pressure', severity: 'warn', value: availGiB, limit: L.ramLowGiB, unit: 'GiB' })
  if (s.vramUsedBytes !== null && s.vramTotalBytes && s.othersVramAtLoadBytes !== null) {
    const othersNow = Math.max(0, s.vramUsedBytes - s.ownVramBytes)
    const growthGiB = Math.round(((othersNow - s.othersVramAtLoadBytes) / GiB) * 10) / 10
    if (growthGiB >= L.vramOthersGrowthGiB && pct(s.vramUsedBytes, s.vramTotalBytes) >= L.vramFullPct) {
      out.push({ kind: 'vram-others', severity: 'warn', value: growthGiB, limit: L.vramOthersGrowthGiB, unit: 'GiB' })
    }
  }
  if (s.weightsInRam && s.ownCpuPct !== null) {
    const others = Math.max(0, Math.round((s.cpuPct - s.ownCpuPct) * 10) / 10)
    if (others >= L.cpuOthersWarnPct) {
      const critical = others >= L.cpuOthersCriticalPct
      out.push({ kind: 'cpu-contention', severity: critical ? 'critical' : 'warn', value: others, limit: critical ? L.cpuOthersCriticalPct : L.cpuOthersWarnPct, unit: '%' })
    }
  }
  // NETRUNNER's own shares are shown (ownShares) but not judged: the operator chose speed over a resource budget.
  return out
}

/** NETRUNNER's own share of each resource (%). GPU load has no per-process value on Windows. */
export function ownShares(s: RiSnapshot): Record<RiResource, number | null> {
  return {
    cpu: s.ownCpuPct,
    ram: s.ownRamBytes === null ? null : pct(s.ownRamBytes, s.ramTotalBytes),
    vram: s.vramTotalBytes ? pct(s.ownVramBytes, s.vramTotalBytes) : null,
    gpu: null,
  }
}

/** A run slower than usual: `usual` is the median speed of the model's earlier runs (at least 5 of them). */
export function speedDrop(model: string, tokensPerSecond: number, earlier: number[], L = RI_LIMITS): Omit<RiFinding, 'since'> | null {
  if (earlier.length < 5 || tokensPerSecond <= 0) return null
  const sorted = [...earlier].sort((a, b) => a - b)
  const usual = sorted[Math.floor(sorted.length / 2)]
  if (tokensPerSecond >= usual * L.speedDropRatio) return null
  return { kind: 'speed-drop', severity: 'warn', model, usual: Math.round(usual * 10) / 10, value: Math.round(tokensPerSecond * 10) / 10, limit: Math.round(usual * L.speedDropRatio * 10) / 10, unit: 'tok/s' }
}

const keyOf = (f: Pick<RiFinding, 'kind' | 'resource' | 'model'>) => `${f.kind}:${f.resource ?? ''}:${f.model ?? ''}`

interface Deps {
  footprint: () => Promise<{ loaded: boolean; ownVramBytes: number; othersVramAtLoadBytes: number | null; weightsInRam: boolean; pids: number[] }>
  emit: (s: RiState) => void
}

/**
 * Samples while a model is loaded: CPU, RAM and GPU every 5 s (cheap), NETRUNNER's own processes every 15 s (a
 * process scan spawns helpers on Windows). Emits the state after every sample.
 */
export class RiMonitor {
  private timer: NodeJS.Timeout | null = null
  private prevCpu = os.cpus()
  private tick = 0
  private own: { cpuPct: number; ramBytes: number } | null = null
  private current = new Map<string, RiFinding>()
  private speed: RiFinding | null = null
  private state: RiState = { time: 0, active: false, findings: [], own: { cpu: null, ram: null, vram: null, gpu: null }, total: { cpu: null, ram: null, vram: null, gpu: null }, history: [] }

  constructor(private readonly deps: Deps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.sample().catch(() => undefined), 5000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get(): RiState {
    return this.state
  }

  /** A finished chat reply or agent task: compare its speed with the model's earlier runs. */
  onRun(model: string, tokensPerSecond: number, earlier: number[]): void {
    const f = speedDrop(model, tokensPerSecond, earlier)
    this.speed = f ? { ...f, since: Date.now() } : null
    this.publish(this.mergeFindings([...this.current.values()].filter(x => x.kind !== 'speed-drop'), Date.now()))
  }

  private async processes(pids: number[]): Promise<{ cpuPct: number; ramBytes: number } | null> {
    const si = await import('systeminformation')
    const list = (await si.processes()).list
    // The model servers and what they started; plus NETRUNNER itself and the OpenCode engine.
    const own = list.filter(p => pids.includes(p.pid) || pids.includes(p.parentPid) || /^(opencode|netrunner)(\.exe)?$/i.test(p.name) || p.pid === process.pid)
    // systeminformation gives each process's CPU as a share of all logical CPUs, like the system total.
    return { cpuPct: Math.round(own.reduce((n, p) => n + (p.cpu ?? 0), 0) * 10) / 10, ramBytes: own.reduce((n, p) => n + (p.memRss ?? 0) * 1024, 0) }
  }

  private async gpu(): Promise<{ used: number; total: number; util: number } | null> {
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true })
      const rows = stdout.trim().split(/\r?\n/).map(l => l.split(',').map(x => Number(x.trim())))
      if (!rows.length || rows.some(r => r.some(n => !Number.isFinite(n)))) return null
      return { used: rows.reduce((n, r) => n + r[0], 0) * 2 ** 20, total: rows.reduce((n, r) => n + r[1], 0) * 2 ** 20, util: Math.max(...rows.map(r => r[2])) }
    } catch {
      return null
    }
  }

  async sample(): Promise<RiState> {
    const fp = await this.deps.footprint()
    const now = Date.now()
    if (!fp.loaded) {
      this.own = null
      this.publish([], false)
      return this.state
    }
    const cpus = os.cpus()
    const cpu = cpuUsage(this.prevCpu, cpus).overall
    this.prevCpu = cpus
    if (this.tick++ % 3 === 0) this.own = await this.processes(fp.pids).catch(() => this.own)
    const g = await this.gpu()
    const snap: RiSnapshot = {
      time: now,
      weightsInRam: fp.weightsInRam,
      cpuPct: cpu,
      ownCpuPct: this.own?.cpuPct ?? null,
      ramAvailableBytes: os.freemem(),
      ramTotalBytes: os.totalmem(),
      ownRamBytes: this.own?.ramBytes ?? null,
      vramUsedBytes: g?.used ?? null,
      vramTotalBytes: g?.total ?? null,
      ownVramBytes: fp.ownVramBytes,
      othersVramAtLoadBytes: fp.othersVramAtLoadBytes,
      gpuPct: g?.util ?? null,
    }
    const findings = this.mergeFindings(assessInterference(snap), now)
    this.state.own = ownShares(snap)
    this.state.total = {
      cpu: Math.round(cpu * 10) / 10,
      ram: pct(snap.ramTotalBytes - snap.ramAvailableBytes, snap.ramTotalBytes),
      vram: g ? pct(g.used, g.total) : null,
      gpu: g?.util ?? null,
    }
    this.publish(findings, true)
    return this.state
  }

  /** Keeps `since` of findings that continue; findings that ended go to the history. */
  private mergeFindings(found: Omit<RiFinding, 'since'>[], now: number): RiFinding[] {
    const next = new Map<string, RiFinding>()
    for (const f of found) next.set(keyOf(f), { ...f, since: this.current.get(keyOf(f))?.since ?? now })
    for (const [k, f] of this.current) {
      if (!next.has(k) && f.kind !== 'speed-drop') this.state.history = [{ kind: f.kind, severity: f.severity, resource: f.resource, since: f.since, until: now }, ...this.state.history].slice(0, 50)
    }
    this.current = next
    return [...next.values(), ...(this.speed ? [this.speed] : [])]
  }

  private publish(findings: RiFinding[], active = this.state.active): void {
    this.state = { ...this.state, time: Date.now(), active, findings }
    this.deps.emit(this.state)
  }
}
