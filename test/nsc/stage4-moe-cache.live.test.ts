// NSC stage 4: hot experts in VRAM. llama.cpp b12020 has a GPU cache for the MoE experts kept in RAM
// (--moe-cache-mib); stock -ot can only move whole expert tensors (all 512 experts of a layer). Coder-Next as the
// agents run it, with caches of several sizes, also with every expert in RAM and only the cache on the GPU.
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage4-moe-cache.live.test.ts --silent=false
import { spawn } from 'node:child_process'
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
const outDir = path.join(home, 'nsc', 'stage4')
const binDir = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp'))
const runtime = new LlamaRuntime({ binaryDir: () => binDir, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })

const CONFIGS: { id: string; extra: string[] }[] = [
  { id: 'fit (now)', extra: [] },
  { id: 'fit + cache 1 GB', extra: ['--moe-cache-mib', '1024'] },
  { id: 'fit + cache 2 GB', extra: ['--moe-cache-mib', '2048'] },
  { id: 'fit + cache 4 GB', extra: ['--moe-cache-mib', '4096'] },
  { id: 'all experts in RAM + cache 4 GB', extra: ['--cpu-moe', '--moe-cache-mib', '4096'] },
  { id: 'all experts in RAM + cache 6 GB', extra: ['--cpu-moe', '--moe-cache-mib', '6144'] },
  { id: 'fit (now), again', extra: [] },
]

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 4: MoE expert cache on the GPU', () => {
  it('measures Coder-Next with and without the expert cache', async () => {
    if (!binDir) throw new Error('llama.cpp runtime not found')
    fs.mkdirSync(outDir, { recursive: true })
    const entry = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    if (!entry) throw new Error('Coder-Next not found')
    const sampler = startSampler(path.join(outDir, 'moe-cache-samples.jsonl'))
    const report: Record<string, unknown> = {}
    for (const c of CONFIGS) {
      const key = crypto.randomBytes(16).toString('hex')
      const port = 18095
      const url = `http://127.0.0.1:${port}`
      const log: string[] = []
      const proc = spawn(path.join(binDir, 'llama-server.exe'), [...serverArgs(entry, port, key, 65536, 2), ...c.extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: binDir })
      const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      try {
        const t0 = Date.now()
        for (let ready = false; !ready; ) {
          if (proc.exitCode !== null) throw new Error(log.slice(-15).join('\n'))
          ready = await fetch(`${url}/health`).then(r => r.ok, () => false)
          if (!ready) await new Promise(r => setTimeout(r, 500))
        }
        const loadMs = Date.now() - t0
        const t1 = Date.now()
        // Two passes: the cache fills during the first one.
        const first = (await runTasks(url, key, entry.id, sampler.samples)).filter(r => r.id !== 'warmup')
        const second = (await runTasks(url, key, entry.id, sampler.samples)).filter(r => r.id !== 'warmup')
        const res = summarize(sampler.samples, t1, Date.now())
        const gen = (runs: typeof first) => Math.round((runs.reduce((n, r) => n + r.genTokPerS, 0) / runs.length) * 10) / 10
        const row = {
          loadMs,
          genFirst: gen(first),
          genSecond: gen(second),
          longPromptFirst: first.find(r => r.id === 'long-context')?.promptTokPerS,
          longPromptSecond: second.find(r => r.id === 'long-context')?.promptTokPerS,
          perTask: second.map(r => `${r.id}:${r.genTokPerS}`).join(' '),
          vramMiBMax: res.vramMiB?.max,
          ownCpuPctMean: res.ownCpuPct?.mean,
          pcieRxMBsMean: res.pcieRxMBs?.mean,
          gpuUtilMean: res.gpuUtil?.mean,
          cacheLog: log.filter(l => /moe.?cache|expert cache|cache_mib|MoE cache/i.test(l)).slice(-12),
          placement: log.filter(l => /llama_params_fit|offloaded \d+\/\d+|CUDA0 model buffer|CPU_Mapped model buffer/.test(l)).slice(-6),
        }
        report[c.id] = row
        console.log(`[moe] ${c.id}: ${JSON.stringify({ ...row, cacheLog: undefined, placement: undefined })}`)
      } catch (err) {
        report[c.id] = { error: String(err).slice(0, 1500) }
        console.log(`[moe] ${c.id}: FAILED ${String(err).slice(0, 400)}`)
      } finally {
        if (proc.exitCode === null) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        await new Promise(r => setTimeout(r, 6000))
        fs.writeFileSync(path.join(outDir, 'moe-cache.json'), JSON.stringify(report, null, 2))
      }
    }
    await sampler.stop()
    expect(Object.keys(report)).toHaveLength(CONFIGS.length)
  }, 3 * 60 * 60_000)
})
