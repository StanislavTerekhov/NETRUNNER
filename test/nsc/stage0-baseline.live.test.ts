// NSC stage 0, part 1: baseline of the three models as NETRUNNER runs them — speed, time to first token, resources
// (CPU, RAM, GPU, VRAM, PCIe) and GPU energy per generated token. Opt-in, needs the models and the GPU:
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage0-baseline.live.test.ts --silent=false
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'
// @ts-expect-error plain ESM helper without types
import { startSampler, summarize } from '../../tools/nsc/sampler.mjs'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage0')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

const root = path.resolve(import.meta.dirname, '..', '..')
const longFile = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'web-tools.ts'), 'utf8').slice(0, 15000)
const TASKS = [
  { id: 'short-ru', max: 200, prompt: 'Коротко объясни, чем отличается процесс от потока в операционной системе.' },
  { id: 'codegen', max: 400, prompt: 'Write a TypeScript function that parses a CSV line with quoted fields (commas and escaped quotes inside quotes). Only the code.' },
  { id: 'long-context', max: 200, prompt: `${longFile}\n\nQuestion: which function decides that the computer has no internet connection, and how? Answer in 3 sentences.` },
]
const MODELS = [
  { id: 'gato-27b-iq3', match: 'Qwen3.8-27B-UD-IQ3_XXS', ctx: 0, parallel: 1 },
  // As the agent engine runs it: 65K context per slot, one agent lane + the chat slot.
  { id: 'coder-next', match: 'Qwen3-Coder-Next-Q4_K_M-00001', ctx: 65536, parallel: 2 },
  { id: 'netrunner-v3-4b', match: 'netrunner-netrunner-v3-Q4_K_M', ctx: 0, parallel: 1 },
]

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 0: baseline', () => {
  it('measures every model on the same tasks', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const sampler = startSampler(path.join(outDir, 'baseline-samples.jsonl'))
    const idle0 = Date.now()
    await new Promise(r => setTimeout(r, 5000))
    const report: Record<string, unknown> = { idle: summarize(sampler.samples, idle0) }
    for (const m of MODELS) {
      const entry = catalog.find(e => e.id.includes(m.match))
      if (!entry) throw new Error(`model not found: ${m.match}`)
      const tLoad = Date.now()
      const s = await runtime.ensure('chat', entry.id, m.ctx, m.parallel)
      const loadMs = Date.now() - tLoad
      const runs: Record<string, unknown>[] = []
      for (const [i, task] of [TASKS[0], ...TASKS].entries()) {
        // The first run warms the server up and is not counted.
        const warm = i === 0
        const t0 = Date.now()
        const res = await fetch(`${s.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
          body: JSON.stringify({
            model: entry.id,
            messages: [{ role: 'user', content: task.prompt }],
            temperature: 0,
            max_tokens: task.max,
            chat_template_kwargs: { enable_thinking: false },
            cache_prompt: false,
          }),
        })
        const data = (await res.json()) as { timings?: Record<string, number> }
        const t1 = Date.now()
        const tm = data.timings ?? {}
        runs.push({
          id: warm ? 'warmup' : task.id,
          promptTokens: tm.prompt_n,
          promptMs: Math.round(tm.prompt_ms),
          promptTokPerS: Math.round((tm.prompt_n / tm.prompt_ms) * 1000 * 10) / 10,
          genTokens: tm.predicted_n,
          genMs: Math.round(tm.predicted_ms),
          genTokPerS: Math.round(tm.predicted_per_second * 10) / 10,
          wallMs: t1 - t0,
          resources: summarize(sampler.samples, t0, t1),
        })
      }
      const measured = runs.filter(r => r.id !== 'warmup') as { genTokens: number; genMs: number; resources: { powerW: { mean: number } | null } }[]
      const genTok = measured.reduce((n, r) => n + r.genTokens, 0)
      const joules = measured.reduce((n, r) => n + (r.resources.powerW?.mean ?? 0) * (r.genMs / 1000), 0)
      report[m.id] = { model: entry.id, sizeGiB: Math.round((entry.sizeBytes / 2 ** 30) * 100) / 100, ctx: s.ctx, parallel: s.parallel, mtp: s.mtp, loadMs, gpuJoulesPerToken: Math.round((joules / genTok) * 100) / 100, runs }
      console.log(`[stage0] ${m.id}: load ${loadMs} ms; ${runs.map(r => `${r.id} ${r.genTokPerS} tok/s, prompt ${r.promptTokPerS} tok/s`).join(' | ')}`)
      await runtime.stopAll()
      await new Promise(r => setTimeout(r, 3000))
    }
    await sampler.stop()
    fs.writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(report, null, 2))
    expect(Object.keys(report)).toHaveLength(MODELS.length + 1)
  }, 60 * 60_000)
})
