// NSC stage 2: reverse interference, measured. Coder-Next runs as NETRUNNER starts it for agents; then something
// else takes CPU (busy threads), RAM (a process holding memory until ~3 GB stay available) or VRAM (a second model
// loaded onto the GPU), and the same tasks run again. The numbers set the thresholds of the RI monitor.
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage2-interference.live.test.ts --silent=false
import { type ChildProcess, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime, serverArgs } from '../../electron/main/services/llamacpp'
// @ts-expect-error plain ESM helper without types
import { startSampler, summarize } from '../../tools/nsc/sampler.mjs'
import { runTasks } from './tasks'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage2')
const binDir = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp'))
const runtime = new LlamaRuntime({ binaryDir: () => binDir, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })

const GiB = 2 ** 30
// Busy loops on n threads, in a separate process so the test itself stays responsive.
const CPU_HOG = `const { Worker } = require('node:worker_threads'); for (let i = 0; i < Number(process.argv[1]); i++) new Worker('for(;;){}', { eval: true })`
// Holds memory (touched, so it is really resident) until only \`keep\` bytes stay available.
const RAM_HOG = `const os = require('node:os'); const keep = Number(process.argv[1]); const held = [];
const fill = () => { while (os.freemem() > keep + 2 ** 30) { const b = Buffer.alloc(2 ** 30, 1); held.push(b) } };
fill(); setInterval(fill, 2000); console.log('held', held.length)`

async function startServer(entry: Parameters<typeof serverArgs>[0], port: number, ctx: number, parallel: number, extra: string[] = []) {
  const key = crypto.randomBytes(16).toString('hex')
  const log: string[] = []
  const proc = spawn(path.join(binDir!, 'llama-server.exe'), [...serverArgs(entry, port, key, ctx, parallel), ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: binDir! })
  const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  const url = `http://127.0.0.1:${port}`
  for (let ready = false; !ready; ) {
    if (proc.exitCode !== null) throw new Error(log.slice(-20).join('\n'))
    ready = await fetch(`${url}/health`).then(r => r.ok, () => false)
    if (!ready) await new Promise(r => setTimeout(r, 500))
  }
  return { url, key, proc }
}

const kill = (p: ChildProcess | null) => p && p.exitCode === null && spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 2: interference on Coder-Next', () => {
  it('measures the model alone and next to CPU, RAM and VRAM load', async () => {
    if (!binDir) throw new Error('llama.cpp runtime not found')
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const coder = catalog.find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    const small = catalog.find(e => e.id.includes('netrunner-netrunner-v3-Q4_K_M'))
    if (!coder || !small) throw new Error('models not found')
    const sampler = startSampler(path.join(outDir, 'interference-samples.jsonl'))
    const report: Record<string, unknown> = {}
    const server = await startServer(coder, 18093, 65536, 2)
    try {
      const measure = async (id: string) => {
        const t0 = Date.now()
        const runs = (await runTasks(server.url, server.key, coder.id, sampler.samples)).filter(r => r.id !== 'warmup')
        const res = summarize(sampler.samples, t0, Date.now())
        const row = {
          genTokPerS: Math.round((runs.reduce((n, r) => n + r.genTokPerS, 0) / runs.length) * 10) / 10,
          longPromptTokPerS: runs.find(r => r.id === 'long-context')?.promptTokPerS,
          cpuPctMean: res.cpuPct?.mean,
          ownCpuPctMean: res.ownCpuPct?.mean,
          ramUsedGiBMax: res.ramUsedGiB?.max,
          ramFreeGiBMin: Math.round((os.totalmem() / GiB - (res.ramUsedGiB?.max ?? 0)) * 10) / 10,
          vramMiBMax: res.vramMiB?.max,
          gpuUtilMean: res.gpuUtil?.mean,
          pcieRxMBsMean: res.pcieRxMBs?.mean,
          runs: runs.map(r => ({ id: r.id, gen: r.genTokPerS, prompt: r.promptTokPerS })),
        }
        report[id] = row
        console.log(`[ri] ${id}: ${JSON.stringify({ ...row, runs: undefined })}`)
        fs.writeFileSync(path.join(outDir, 'interference.json'), JSON.stringify(report, null, 2))
      }
      await measure('alone')
      for (const threads of [8, 16, 24]) {
        const hog = spawn(process.execPath, ['-e', CPU_HOG, String(threads)], { windowsHide: true })
        await new Promise(r => setTimeout(r, 3000))
        try {
          await measure(`cpu-${threads}-busy-threads`)
        } finally {
          kill(hog)
          await new Promise(r => setTimeout(r, 3000))
        }
      }
      for (const keepGiB of [8, 3]) {
        const hog = spawn(process.execPath, ['--max-old-space-size=200', '-e', RAM_HOG, String(keepGiB * GiB)], { windowsHide: true })
        await new Promise(r => setTimeout(r, 20000))
        try {
          await measure(`ram-${keepGiB}GiB-available`)
        } finally {
          kill(hog)
          await new Promise(r => setTimeout(r, 8000))
        }
      }
      await measure('alone-again')
      // A second model fully on the GPU, loaded after Coder-Next was placed: VRAM it did not plan for.
      const other = await startServer(small, 18094, 16384, 1, ['-ngl', '99'])
      try {
        await measure('vram-second-model-on-gpu')
      } finally {
        kill(other.proc)
        await new Promise(r => setTimeout(r, 5000))
      }
      await measure('alone-final')
    } finally {
      kill(server.proc)
      await sampler.stop()
    }
    expect(Object.keys(report).length).toBeGreaterThan(5)
  }, 2 * 60 * 60_000)
})
