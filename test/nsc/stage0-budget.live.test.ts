// NSC stage 0, part 2: what the rule "NETRUNNER leaves at least half of every resource free" costs. Each model runs
// as NETRUNNER starts it (full) and under the budget: --fit keeps NETRUNNER's VRAM at half the card, fewer CPU
// threads. Same tasks as the baseline. Opt-in, needs the models and the GPU:
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage0-budget.live.test.ts --silent=false
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime, serverArgs } from '../../electron/main/services/llamacpp'
// @ts-expect-error plain ESM helper without types
import { startSampler, summarize } from '../../tools/nsc/sampler.mjs'
import { type Run, runTasks } from './tasks'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage0')
const binDir = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp'))
const runtime = new LlamaRuntime({ binaryDir: () => binDir, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })

const MODELS = [
  { id: 'gato-27b-iq3', match: 'Qwen3.8-27B-UD-IQ3_XXS', ctx: 16384, parallel: 1 },
  { id: 'coder-next', match: 'Qwen3-Coder-Next-Q4_K_M-00001', ctx: 65536, parallel: 2 },
  { id: 'netrunner-v3-4b', match: 'netrunner-netrunner-v3-Q4_K_M', ctx: 16384, parallel: 1 },
]
// The 5950X has 16 cores / 32 threads; llama.cpp uses 16 by default. Since this measurement serverArgs gives MoE
// models 8 threads itself, so for Coder-Next 'full' now equals 'full+8-threads'.
const CONFIGS = [
  { id: 'full', vramBudget: false, threads: 0, mtp: false },
  // Under the budget 8 threads beat 16 on Coder-Next: check whether that holds without the VRAM limit too.
  { id: 'full+8-threads', vramBudget: false, threads: 8, mtp: false, only: 'coder-next' },
  { id: 'vram-half', vramBudget: true, threads: 0, mtp: false },
  { id: 'vram-half+8-threads', vramBudget: true, threads: 8, mtp: false },
  // When the dense 27B is pushed half into RAM, its own MTP head may win back speed (it did for Q4_K_M).
  { id: 'vram-half+mtp', vramBudget: true, threads: 0, mtp: true, only: 'gato-27b-iq3' },
]

function gpuMiB(): { total: number; used: number } {
  const [total, used] = execFileSync('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim().split(',').map(Number)
  return { total, used }
}

async function waitHealthy(url: string, proc: ReturnType<typeof spawn>, log: string[]): Promise<void> {
  const until = Date.now() + 10 * 60_000
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`llama-server exited ${proc.exitCode}: ${log.slice(-20).join('\n')}`)
    try {
      if ((await fetch(`${url}/health`)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('llama-server did not become ready')
}

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 0: cost of the 50% budget', () => {
  it('measures every model with and without the budget', async () => {
    if (!binDir) throw new Error('llama.cpp runtime not found')
    const bin = path.join(binDir, 'llama-server.exe')
    const catalog = await runtime.catalog.list()
    const sampler = startSampler(path.join(outDir, 'budget-samples.jsonl'))
    const report: Record<string, Record<string, unknown>> = {}
    // NSC_MODELS=coder-next,… measures only those models.
    const only = process.env.NSC_MODELS?.split(',')
    for (const m of MODELS.filter(m => !only || only.includes(m.id))) {
      const entry = catalog.find(e => e.id.includes(m.match))
      if (!entry) throw new Error(`model not found: ${m.match}`)
      report[m.id] = {}
      for (const c of CONFIGS.filter(c => !c.only || c.only === m.id)) {
        const gpu = gpuMiB()
        const key = crypto.randomBytes(16).toString('hex')
        const port = 18090
        const args = serverArgs(entry, port, key, m.ctx, m.parallel, { mtp: c.mtp })
        // --fit-target is the VRAM it leaves free: everything above half of the card that is free now.
        const margin = c.vramBudget ? Math.max(1024, gpu.total - gpu.used - gpu.total / 2) : null
        if (margin !== null) args.push('--fit-target', String(Math.round(margin)))
        if (c.threads) args.push('-t', String(c.threads), '-tb', String(c.threads))
        const log: string[] = []
        const tLoad = Date.now()
        const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: binDir })
        const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
        proc.stdout?.on('data', onData)
        proc.stderr?.on('data', onData)
        try {
          await waitHealthy(`http://127.0.0.1:${port}`, proc, log)
          const loadMs = Date.now() - tLoad
          const runs: Run[] = await runTasks(`http://127.0.0.1:${port}`, key, entry.id, sampler.samples)
          const measured = runs.filter(r => r.id !== 'warmup')
          const t0 = Date.now() - runs.reduce((n, r) => n + r.wallMs, 0)
          const res = summarize(sampler.samples, t0, Date.now())
          const row = {
            fitTargetMiB: margin,
            threads: c.threads || 'default',
            loadMs,
            genTokPerS: Math.round((measured.reduce((n, r) => n + r.genTokPerS, 0) / measured.length) * 10) / 10,
            longPromptTokPerS: measured.find(r => r.id === 'long-context')?.promptTokPerS,
            vramMiBMax: res.vramMiB?.max,
            vramMiBOwn: res.vramMiB ? res.vramMiB.max - gpu.used : null,
            ownCpuPctMean: res.ownCpuPct?.mean,
            cpuPctMean: res.cpuPct?.mean,
            ownRamGiBMax: res.ownRamGiB?.max,
            ramUsedGiBMax: res.ramUsedGiB?.max,
            gpuUtilMean: res.gpuUtil?.mean,
            fitLines: log.filter(l => /llama_params_fit|offloaded \d+\/\d+ layers|CPU_Mapped model buffer|CUDA0 model buffer/.test(l)).slice(-8),
            runs,
          }
          report[m.id][c.id] = row
          console.log(`[budget] ${m.id} ${c.id}: ${JSON.stringify({ ...row, runs: undefined, fitLines: undefined })}`)
        } catch (err) {
          // One failed configuration (for example no MTP head) must not lose the others.
          report[m.id][c.id] = { error: String(err).slice(0, 2000) }
          console.log(`[budget] ${m.id} ${c.id}: FAILED ${String(err).slice(0, 300)}`)
        } finally {
          proc.kill()
          await new Promise(r => setTimeout(r, 4000))
        }
        fs.writeFileSync(path.join(outDir, only ? `budget-${only.join('-')}.json` : 'budget.json'), JSON.stringify(report, null, 2))
      }
    }
    await sampler.stop()
    expect(Object.keys(report).length).toBeGreaterThan(0)
  }, 3 * 60 * 60_000)
})
