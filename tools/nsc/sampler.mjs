// NSC stage 0: resource sampler. Once a second: GPU (util, VRAM, power, PCIe rx/tx) from `nvidia-smi dmon`, system CPU
// and RAM, and what NETRUNNER's own processes take (llama-server, opencode, NETRUNNER/electron). Writes JSON lines.
//   node tools/nsc/sampler.mjs <out.jsonl>          (stops on Ctrl+C or when the parent kills it)
//   import { startSampler } from './sampler.mjs'     (returns { stop(): Promise<Sample[]> })
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import si from 'systeminformation'

const OWN = /^(llama-server|opencode|netrunner|electron)(\.exe)?$/i

export function startSampler(outFile = null) {
  const samples = []
  const out = outFile ? fs.createWriteStream(outFile, { flags: 'a' }) : null
  let gpu = { gpuUtil: null, vramMiB: null, powerW: null, pcieRxMBs: null, pcieTxMBs: null }
  // dmon columns with -s pumt: gpu pwr gtemp mtemp sm mem enc dec jpg ofa fb bar1 ccpm rxpci txpci (names checked from its header)
  const dmon = spawn('nvidia-smi', ['dmon', '-s', 'pumt', '-d', '1'], { windowsHide: true })
  let cols = []
  let pending = ''
  // dmon writes each row in several chunks: parse whole lines only.
  dmon.stdout.on('data', d => {
    pending += d.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('# gpu')) cols = line.slice(1).trim().split(/\s+/)
      else if (line && !line.startsWith('#') && cols.length) {
        const v = line.trim().split(/\s+/)
        const get = name => {
          const i = cols.indexOf(name)
          const n = i >= 0 ? Number(v[i]) : NaN
          return Number.isFinite(n) ? n : null
        }
        gpu = { gpuUtil: get('sm'), vramMiB: get('fb'), powerW: get('pwr'), pcieRxMBs: get('rxpci'), pcieTxMBs: get('txpci') }
      }
    }
  })
  let stopped = false
  const loop = (async () => {
    const totalMem = (await si.mem()).total
    while (!stopped) {
      const t = Date.now()
      const [load, mem, procs] = await Promise.all([si.currentLoad(), si.mem(), si.processes()])
      const own = procs.list.filter(p => OWN.test(p.name))
      const s = {
        t,
        cpuPct: Math.round(load.currentLoad * 10) / 10,
        ramUsedGiB: Math.round((mem.active / 2 ** 30) * 100) / 100,
        ramTotalGiB: Math.round((totalMem / 2 ** 30) * 100) / 100,
        ownCpuPct: Math.round(own.reduce((n, p) => n + (p.cpu || 0), 0) * 10) / 10,
        ownRamGiB: Math.round((own.reduce((n, p) => n + (p.memRss || 0), 0) / 2 ** 20) * 100) / 100,
        ...gpu,
      }
      samples.push(s)
      out?.write(`${JSON.stringify(s)}\n`)
      await new Promise(r => setTimeout(r, Math.max(0, 1000 - (Date.now() - t))))
    }
  })()
  return {
    samples,
    async stop() {
      stopped = true
      await loop
      dmon.kill()
      out?.end()
      return samples
    },
  }
}

/** Mean / max of each field over a time window. */
export function summarize(samples, from = 0, to = Infinity) {
  const w = samples.filter(s => s.t >= from && s.t <= to)
  const keys = ['cpuPct', 'ramUsedGiB', 'ownCpuPct', 'ownRamGiB', 'gpuUtil', 'vramMiB', 'powerW', 'pcieRxMBs', 'pcieTxMBs']
  const out = { n: w.length }
  for (const k of keys) {
    const v = w.map(s => s[k]).filter(x => typeof x === 'number')
    out[k] = v.length ? { mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, max: Math.max(...v) } : null
  }
  return out
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const s = startSampler(process.argv[2] ?? 'samples.jsonl')
  process.on('SIGINT', () => void s.stop().then(() => process.exit(0)))
  process.on('SIGTERM', () => void s.stop().then(() => process.exit(0)))
}
