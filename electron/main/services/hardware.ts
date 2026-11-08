import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { GpuInfo, HardwareInfo } from '../../shared/ipc'

const run = promisify(execFile)
const MIB = 1024 * 1024

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  return output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [name, total, used, util, driver] = line.split(',').map(s => s.trim())
      const num = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null)
      return {
        name,
        vramTotalBytes: (num(total) ?? 0) * MIB,
        vramUsedBytes: (num(used) ?? 0) * MIB,
        utilizationPct: num(util),
        driver: driver || null,
      }
    })
}

/**
 * Real measurements only. GPU data comes from nvidia-smi (WMI under-reports VRAM above 4 GB);
 * when it is unavailable the reason is returned instead of a guess.
 */
export async function readHardware(): Promise<HardwareInfo> {
  const cpus = os.cpus()
  let gpus: GpuInfo[] = []
  let gpuError: string | null = null
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
    )
    gpus = parseNvidiaSmi(stdout)
    if (gpus.length === 0) gpuError = 'nvidia-smi reported no GPUs'
  } catch (err) {
    gpuError = `No NVIDIA GPU data (nvidia-smi unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})`
  }
  return {
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuThreads: cpus.length,
    ramTotalBytes: os.totalmem(),
    ramFreeBytes: os.freemem(),
    gpus,
    gpuError,
  }
}
