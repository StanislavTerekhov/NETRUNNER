import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { DiskSample, GpuSample, ProcessSample, TelemetrySample } from '../../shared/ipc'

const run = promisify(execFile)
const MIB = 1024 * 1024

type CpuTimes = os.CpuInfo['times']
const busy = (t: CpuTimes) => t.user + t.nice + t.sys + t.irq
const total = (t: CpuTimes) => busy(t) + t.idle

/** Per-core and overall CPU utilisation between two os.cpus() snapshots (0..100). */
export function cpuUsage(prev: os.CpuInfo[], next: os.CpuInfo[]): { overall: number; cores: number[] } {
  let b = 0
  let t = 0
  const cores = next.map((c, i) => {
    const p = prev[i]
    if (!p) return 0
    const db = busy(c.times) - busy(p.times)
    const dt = total(c.times) - total(p.times)
    b += db
    t += dt
    return dt > 0 ? Math.max(0, Math.min(100, (db / dt) * 100)) : 0
  })
  return { overall: t > 0 ? Math.max(0, Math.min(100, (b / t) * 100)) : 0, cores }
}

const GPU_QUERY = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.sm'

/** Parse `nvidia-smi --query-gpu=<GPU_QUERY> --format=csv,noheader,nounits`. "[N/A]" fields become null. */
export function parseGpuSamples(out: string): GpuSample[] {
  const num = (s: string | undefined) => (s && /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null)
  return out
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [name, util, used, totalMem, temp, power, limit, clock] = l.split(',').map(s => s.trim())
      return {
        name,
        utilizationPct: num(util),
        vramUsedBytes: (num(used) ?? 0) * MIB,
        vramTotalBytes: (num(totalMem) ?? 0) * MIB,
        temperatureC: num(temp),
        powerW: num(power),
        powerLimitW: num(limit),
        clockMhz: num(clock),
      }
    })
}

/** Processes NETRUNNER depends on: llama.cpp model servers and the OpenCode agent engine. */
const WATCHED = ['llama-server', 'opencode']

type SI = typeof import('systeminformation')

/**
 * Samples real system metrics while at least one view is subscribed. Cheap values (CPU, RAM, GPU) every
 * 2 s; process, network and disk values (which spawn helper processes on Windows) less often.
 */
export class TelemetryService {
  private subscribers = 0
  private timer: NodeJS.Timeout | null = null
  private prevCpu = os.cpus()
  private tick = 0
  private si: SI | null = null
  private last: Pick<TelemetrySample, 'processes' | 'disks' | 'netRxBps' | 'netTxBps'> = { processes: null, disks: null, netRxBps: null, netTxBps: null }

  constructor(
    private readonly emit: (s: TelemetrySample) => void,
    private readonly appMemory: () => number,
  ) {}

  subscribe(): void {
    this.subscribers++
    if (!this.timer) {
      this.prevCpu = os.cpus()
      void this.sample()
      this.timer = setInterval(() => void this.sample(), 2000)
    }
  }

  unsubscribe(): void {
    this.subscribers = Math.max(0, this.subscribers - 1)
    if (this.subscribers === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    this.subscribers = 0
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async gpus(): Promise<{ gpus: GpuSample[]; error: string | null }> {
    try {
      const { stdout } = await run('nvidia-smi', [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true })
      return { gpus: parseGpuSamples(stdout), error: null }
    } catch (err) {
      return { gpus: [], error: `nvidia-smi unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` }
    }
  }

  private async slow(): Promise<void> {
    this.si ??= await import('systeminformation')
    const si = this.si
    const jobs: Promise<void>[] = []
    if (this.tick % 3 === 0) {
      jobs.push(
        si
          .processes()
          .then(p => {
            const groups = new Map<string, ProcessSample>()
            for (const proc of p.list) {
              const base = proc.name.replace(/\.exe$/i, '')
              const key = WATCHED.find(w => base.toLowerCase() === w.toLowerCase())
              if (!key) continue
              const g = groups.get(key) ?? { name: key, pids: 0, cpuPct: 0, memBytes: 0 }
              g.pids++
              g.cpuPct += proc.cpu ?? 0
              g.memBytes += (proc.memRss ?? 0) * 1024
              groups.set(key, g)
            }
            this.last.processes = [...groups.values()].sort((a, b) => b.memBytes - a.memBytes)
          })
          .catch(() => undefined),
        si
          .networkStats()
          .then(stats => {
            const valid = stats.filter(s => typeof s.rx_sec === 'number' && s.rx_sec >= 0)
            this.last.netRxBps = valid.length ? valid.reduce((a, s) => a + (s.rx_sec ?? 0), 0) : null
            this.last.netTxBps = valid.length ? valid.reduce((a, s) => a + (s.tx_sec ?? 0), 0) : null
          })
          .catch(() => undefined),
      )
    }
    if (this.tick % 15 === 0) {
      jobs.push(
        si
          .fsSize()
          .then(fs => {
            this.last.disks = fs.filter(f => f.size > 0).map<DiskSample>(f => ({ mount: f.mount, usedBytes: f.used, sizeBytes: f.size }))
          })
          .catch(() => undefined),
      )
    }
    await Promise.all(jobs)
  }

  private async sample(): Promise<void> {
    const cpus = os.cpus()
    const usage = cpuUsage(this.prevCpu, cpus)
    this.prevCpu = cpus
    const [gpu] = await Promise.all([this.gpus(), this.slow()])
    this.tick++
    this.emit({
      time: Date.now(),
      cpuPct: usage.overall,
      cpuCores: usage.cores,
      cpuModel: cpus[0]?.model.trim() ?? 'unknown',
      // Windows exposes no CPU temperature to unprivileged processes without a vendor driver.
      cpuTempC: null,
      ramUsedBytes: os.totalmem() - os.freemem(),
      ramTotalBytes: os.totalmem(),
      gpus: gpu.gpus,
      gpuError: gpu.error,
      ...this.last,
      appMemBytes: this.appMemory(),
    })
  }
}
