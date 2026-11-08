// NSC stage 5: NETRUNNER's own llama.cpp build (fork of b12020) against the official one, on Coder-Next as the agents
// run it, without and with the GPU expert cache. NSC_CONFIGS picks configurations by id (comma-separated).
//   NETRUNNER_LIVE=1 [NSC_CONFIGS=…] npx vitest run test/nsc/stage5-fork.live.test.ts --silent=false
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
const outDir = path.join(home, 'nsc', 'stage5')
const official = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp'))
const stock = path.join(home, 'fork', 'build-stock', 'bin')
const fork = path.join(home, 'fork', 'build-fork', 'bin')
const runtime = new LlamaRuntime({ binaryDir: () => official, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })

const CACHE = ['--cpu-moe', '--moe-cache-mib', '6144']
const ALL: { id: string; bin: string; extra: string[]; env?: Record<string, string> }[] = [
  { id: 'official', bin: official ?? '', extra: [] },
  { id: 'stock build', bin: stock, extra: [] },
  { id: 'official + cache 6 GB', bin: official ?? '', extra: CACHE },
  { id: 'stock build + cache 6 GB', bin: stock, extra: CACHE },
  { id: 'official + cache 6 GB + no-mmap', bin: official ?? '', extra: [...CACHE, '-lm', 'none'] },
  { id: 'fork + cache 6 GB + no-mmap', bin: fork, extra: [...CACHE, '-lm', 'none'], env: { LLAMA_MOE_CACHE_STATS: '32' } },
  { id: 'fork + cache 6 GB', bin: fork, extra: CACHE, env: { LLAMA_MOE_CACHE_STATS: '32', LLAMA_MOE_CACHE_FREQ: path.join(home, 'nsc', 'stage5', 'freq.txt') } },
  { id: 'fork + cache 6 GB + pinned', bin: fork, extra: CACHE, env: { LLAMA_MOE_CACHE_STATS: '32', LLAMA_MOE_CACHE_PIN: path.join(home, 'nsc', 'stage5', 'pin.txt') } },
]
const only = process.env.NSC_CONFIGS?.split(',')
const CONFIGS = ALL.filter(c => !only || only.includes(c.id))

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 5: own llama.cpp build', () => {
  it('measures the builds on Coder-Next', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const entry = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    if (!entry) throw new Error('Coder-Next not found')
    const sampler = startSampler(path.join(outDir, 'fork-samples.jsonl'))
    const file = path.join(outDir, only ? `fork-${only.map(s => s.replace(/\W+/g, '_')).join('-')}.json` : 'fork.json')
    const report: Record<string, unknown> = {}
    for (const c of CONFIGS) {
      const key = crypto.randomBytes(16).toString('hex')
      const port = 18096
      const url = `http://127.0.0.1:${port}`
      const log: string[] = []
      const proc = spawn(path.join(c.bin, 'llama-server.exe'), [...serverArgs(entry, port, key, 65536, 2), ...c.extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: c.bin, env: { ...process.env, ...c.env } })
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
          longPromptSecond: second.find(r => r.id === 'long-context')?.promptTokPerS,
          perTask: second.map(r => `${r.id}:${r.genTokPerS}`).join(' '),
          vramMiBMax: res.vramMiB?.max,
          ownCpuPctMean: res.ownCpuPct?.mean,
          pcieRxMBsMean: res.pcieRxMBs?.mean,
          gpuUtilMean: res.gpuUtil?.mean,
          cacheLog: log.filter(l => /moe_cache|MoE cache/i.test(l)).slice(-40),
        }
        report[c.id] = row
        console.log(`[fork] ${c.id}: ${JSON.stringify({ ...row, cacheLog: undefined })}`)
      } catch (err) {
        report[c.id] = { error: String(err).slice(0, 1500) }
        console.log(`[fork] ${c.id}: FAILED ${String(err).slice(0, 400)}`)
      } finally {
        if (proc.exitCode === null) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        await new Promise(r => setTimeout(r, 6000))
        fs.writeFileSync(file, JSON.stringify(report, null, 2))
        if (c.env) fs.writeFileSync(path.join(outDir, `${c.id.replace(/\W+/g, '_')}.log`), log.join('\n'))
      }
    }
    await sampler.stop()
    expect(Object.keys(report)).toHaveLength(CONFIGS.length)
  }, 3 * 60 * 60_000)
})
