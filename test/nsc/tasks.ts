// NSC stage 0: the tasks every model is measured on, and one measured request.
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error plain ESM helper without types
import { summarize } from '../../tools/nsc/sampler.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const longFile = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'web-tools.ts'), 'utf8').slice(0, 15000)
export const TASKS = [
  { id: 'short-ru', max: 200, prompt: 'Коротко объясни, чем отличается процесс от потока в операционной системе.' },
  { id: 'codegen', max: 400, prompt: 'Write a TypeScript function that parses a CSV line with quoted fields (commas and escaped quotes inside quotes). Only the code.' },
  { id: 'long-context', max: 200, prompt: `${longFile}\n\nQuestion: which function decides that the computer has no internet connection, and how? Answer in 3 sentences.` },
]

export type Run = { id: string; promptTokens: number; promptTokPerS: number; genTokens: number; genMs: number; genTokPerS: number; wallMs: number; resources: ReturnType<typeof summarize> }

/** Warm-up + every task; the warm-up run is labelled and left out of the averages by the callers. */
export async function runTasks(url: string, key: string, model: string, samples: unknown[]): Promise<Run[]> {
  const runs: Run[] = []
  for (const [i, task] of [TASKS[0], ...TASKS].entries()) {
    const t0 = Date.now()
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: task.prompt }],
        temperature: 0,
        max_tokens: task.max,
        chat_template_kwargs: { enable_thinking: false },
        cache_prompt: false,
      }),
    })
    const tm = ((await res.json()) as { timings?: Record<string, number> }).timings ?? {}
    const t1 = Date.now()
    runs.push({
      id: i === 0 ? 'warmup' : task.id,
      promptTokens: tm.prompt_n,
      promptTokPerS: Math.round((tm.prompt_n / tm.prompt_ms) * 1000 * 10) / 10,
      genTokens: tm.predicted_n,
      genMs: Math.round(tm.predicted_ms),
      genTokPerS: Math.round(tm.predicted_per_second * 10) / 10,
      wallMs: t1 - t0,
      resources: summarize(samples, t0, t1),
    })
  }
  return runs
}
