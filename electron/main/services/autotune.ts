import os from 'node:os'
import type { AutotuneEvent, BenchResult, LaunchProfile, ModelProfile } from '../../shared/autotune'
import type { Database } from './db'
import { type CatalogEntry, gpuTotalBytes, type LlamaRuntime } from './llamacpp'

/** Saved launch profiles (SQLite), one per model. */
export class ProfileStore {
  constructor(private readonly store: Database) {}

  get(model: string): ModelProfile | null {
    const row = this.store.db.prepare('SELECT data FROM model_profiles WHERE model = ?').get(model) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as ModelProfile) : null
  }

  /** The profile applied at launch: only an active one, and only if it changes something. */
  active(model: string): LaunchProfile | null {
    const p = this.get(model)
    return p?.status === 'active' && Object.keys(p.profile).length ? p.profile : null
  }

  all(): ModelProfile[] {
    return (this.store.db.prepare('SELECT data FROM model_profiles ORDER BY model').all() as { data: string }[]).map(r => JSON.parse(r.data) as ModelProfile)
  }

  save(p: ModelProfile): void {
    this.store.db.prepare('INSERT INTO model_profiles (model, data) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET data = excluded.data').run(p.model, JSON.stringify(p))
  }

  delete(model: string): void {
    this.store.db.prepare('DELETE FROM model_profiles WHERE model = ?').run(model)
  }
}

/** What the operator waits for: a typical request reads 2000 prompt tokens and writes 300 (seconds). */
export function typicalSeconds(r: BenchResult): number {
  return 2000 / r.promptTokPerS + 300 / r.genTokPerS
}

/**
 * A candidate is kept only if a typical request gets at least 5% shorter — beyond the run-to-run noise measured in
 * stages 0–2 — and neither speed falls by more than 25% (no trading one kind of work away for the other).
 */
export function isBetter(a: BenchResult, b: BenchResult): boolean {
  return typicalSeconds(a) <= typicalSeconds(b) * 0.95 && a.genTokPerS >= b.genTokPerS * 0.75 && a.promptTokPerS >= b.promptTokPerS * 0.75
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** After tuning, real runs are slower than before it: at least 5 runs on each side, median 15% lower. */
export function shouldRevert(before: number[], after: number[]): boolean {
  return before.length >= 5 && after.length >= 5 && median(after) < 0.85 * median(before)
}

/**
 * What can be tuned for a model, one setting at a time (coordinate search, starting from the defaults):
 * CPU threads only when weights also run on the CPU (MoE experts, or a model larger than the VRAM), the prompt
 * batch size, MTP for models that have the head, and for MoE models the GPU expert cache (a third and a half of the
 * VRAM; stage 4: 6 of 12 GB gave +22% generation on Coder-Next, 1 GB −41%, so small caches are not tried).
 */
export function tuningAxes(e: CatalogEntry, vramBytes: number | null, logicalCpus = os.availableParallelism()): { key: keyof LaunchProfile; values: (number | boolean)[] }[] {
  const moe = (e.expertCount ?? 0) > 0
  const onCpu = moe || (vramBytes !== null && e.sizeBytes > vramBytes * 0.9)
  const axes: { key: keyof LaunchProfile; values: (number | boolean)[] }[] = []
  if (e.kind !== 'chat') return axes
  if (moe && vramBytes) {
    const gib = (f: number) => Math.floor((vramBytes * f) / 2 ** 30) * 1024
    const values = [...new Set([gib(1 / 3), gib(1 / 2)])].filter(n => n >= 2048)
    if (values.length) axes.push({ key: 'moeCacheMib', values })
  }
  if (onCpu) {
    // Defaults: a quarter of the logical CPUs for MoE (serverArgs), llama.cpp's own (physical cores) otherwise.
    const def = moe ? Math.max(4, Math.floor(logicalCpus / 4)) : Math.max(1, Math.floor(logicalCpus / 2))
    const values = [...new Set([logicalCpus / 8, logicalCpus / 4, (3 * logicalCpus) / 8, logicalCpus / 2].map(n => Math.max(2, Math.floor(n))))].filter(n => n !== def)
    if (values.length) axes.push({ key: 'threads', values })
  }
  const ub = moe ? 4096 : 2048
  axes.push({ key: 'ubatch', values: [ub / 2, ub * 2] })
  if (e.mtp) axes.push({ key: 'mtp', values: [!(vramBytes !== null && e.sizeBytes > vramBytes)] })
  return axes
}

/** What the model is tuned for: NEURAL CORE chat, or the agents (the agent model). */
export type TuneUse = 'chat' | 'agent'

// Benchmarks, built in so every run and every machine measures the same thing.
// chat: code and Russian prose (generation; speculative decoding with MTP behaves very differently on them) and a
// ~4K-token prompt (prompt reading).
// agent: what agent steps do — code generated after a short and after a ~7K-token code context. Stage 4 showed why
// it must differ: the GPU expert cache won +22% on the chat benchmark and lost 10–17% in the agent pipeline.
const code = (n: number) => Array.from({ length: n }, (_, i) => `export function step${i}(x: number): number {\n  return x * ${i + 3} + ${(i * 7) % 11}\n}`).join('\n')
const CSV = 'Write a TypeScript function that parses a CSV line with quoted fields (commas and escaped quotes inside quotes). Only the code.'
const BENCH: Record<TuneUse, { prompt: string; max: number; gen: boolean; promptSpeed: boolean }[]> = {
  chat: [
    { prompt: CSV, max: 192, gen: true, promptSpeed: false },
    { prompt: 'Объясни простыми словами, чем процесс отличается от потока в операционной системе и когда что использовать.', max: 192, gen: true, promptSpeed: false },
    { prompt: `${code(260)}\n\nWhich function returns x * 100 + 9? Answer with its name only.`, max: 48, gen: false, promptSpeed: true },
  ],
  agent: [
    { prompt: CSV, max: 192, gen: true, promptSpeed: false },
    { prompt: `${code(450)}\n\nWrite a TypeScript function stepTable(x: number): number[] that returns the results of step0 … step20 for x, with a short doc comment. Only the code.`, max: 192, gen: true, promptSpeed: true },
  ],
}

interface Deps {
  runtime: LlamaRuntime
  profiles: ProfileStore
  emit: (e: AutotuneEvent) => void
  /** Speeds of real runs of a model before and after a moment (per source: chat replies, agent tasks). */
  speedsAround: (model: string, at: string) => { before: number[]; after: number[] }[]
  /** Another program is slowing the models down right now (RI monitor): no rollback is decided then. */
  interference: () => boolean
}

/**
 * NSC stage 3: finds faster llama-server settings for a model by measuring them, keeps a setting only when it beats
 * the defaults by more than the noise, and reverts it by itself when real runs afterwards are clearly slower.
 */
export class Autotuner {
  private running: string | null = null

  constructor(private readonly deps: Deps) {}

  get busy(): string | null {
    return this.running
  }

  private async bench(modelId: string, profile: LaunchProfile, ctx: number, parallel: number, use: TuneUse): Promise<BenchResult> {
    const rt = this.deps.runtime
    rt.launchOverride = { modelId, profile }
    await rt.stop('chat')
    const t0 = Date.now()
    const s = await rt.ensure('chat', modelId, ctx, parallel)
    const loadMs = Date.now() - t0
    const ask = async (prompt: string, max: number) => {
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: max, cache_prompt: false, chat_template_kwargs: { enable_thinking: false } }),
      })
      if (!res.ok) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const tm = ((await res.json()) as { timings?: Record<string, number> }).timings
      if (!tm) throw new Error('llama-server returned no timings')
      return tm
    }
    const bench = BENCH[use]
    await ask(bench[0].prompt, 16) // warm-up, not counted
    const gen: number[] = []
    let promptSpeed = 0
    for (const b of bench) {
      const tm = await ask(b.prompt, b.max)
      if (b.gen) gen.push(tm.predicted_per_second)
      if (b.promptSpeed) promptSpeed = (tm.prompt_n / tm.prompt_ms) * 1000
    }
    const r = (n: number) => Math.round(n * 10) / 10
    return { genTokPerS: r(gen.reduce((a, b) => a + b, 0) / gen.length), promptTokPerS: r(promptSpeed), loadMs }
  }

  async tune(modelId: string, ctx: number, parallel: number, use: TuneUse = 'chat'): Promise<ModelProfile> {
    const rt = this.deps.runtime
    if (this.running) throw new Error(`Already tuning ${this.running}`)
    if (rt.pinned) throw new Error('The agent engine is using a model; stop the engine before tuning')
    const entry = await rt.catalog.get(modelId)
    const axes = tuningAxes(entry, await gpuTotalBytes())
    const wasLoaded = (await rt.running()).some(r => r.name === modelId)
    this.running = modelId
    this.deps.emit({ type: 'start', model: modelId, candidates: axes.reduce((n, a) => n + a.values.length, 0) + 2 })
    const tried: ModelProfile['tried'] = []
    const measure = async (profile: LaunchProfile): Promise<BenchResult | null> => {
      try {
        return await this.bench(modelId, profile, ctx, parallel, use)
      } catch (err) {
        tried.push({ profile, result: null, error: String(err instanceof Error ? err.message : err).slice(0, 300), kept: false })
        this.deps.emit({ type: 'measured', model: modelId, profile, result: null, error: tried.at(-1)!.error, kept: false })
        return null
      }
    }
    try {
      const defaults = await measure({})
      if (!defaults) throw new Error(tried[0]?.error ?? 'the defaults could not be measured')
      tried.push({ profile: {}, result: defaults, kept: true })
      this.deps.emit({ type: 'measured', model: modelId, profile: {}, result: defaults, kept: true })
      let best: LaunchProfile = {}
      let bestResult = defaults
      for (const axis of axes) {
        for (const value of axis.values) {
          const candidate = { ...best, [axis.key]: value }
          const result = await measure(candidate)
          if (!result) continue
          const kept = isBetter(result, bestResult)
          tried.push({ profile: candidate, result, kept })
          this.deps.emit({ type: 'measured', model: modelId, profile: candidate, result, kept })
          if (kept) {
            best = candidate
            bestResult = result
          }
        }
      }
      // The defaults once more: the two runs show the noise, and the choice must beat both.
      const again = Object.keys(best).length ? await measure({}) : null
      if (again) {
        tried.push({ profile: {}, result: again, kept: false })
        this.deps.emit({ type: 'measured', model: modelId, profile: {}, result: again, kept: false })
      }
      const holds = !again || isBetter(bestResult, again)
      // When the defaults stay, report the mean of their two measurements rather than the first one alone.
      const mean = (a: BenchResult, b: BenchResult | null): BenchResult =>
        b ? { genTokPerS: Math.round(((a.genTokPerS + b.genTokPerS) / 2) * 10) / 10, promptTokPerS: Math.round(((a.promptTokPerS + b.promptTokPerS) / 2) * 10) / 10, loadMs: a.loadMs } : a
      const profile: ModelProfile = {
        model: modelId,
        use,
        profile: holds ? best : {},
        status: 'active',
        tunedAt: new Date().toISOString(),
        defaults,
        defaultsAgain: again,
        chosen: holds ? bestResult : mean(defaults, again),
        tried,
        note: holds ? null : 'The best candidate did not beat the second measurement of the defaults; defaults kept.',
      }
      this.deps.profiles.save(profile)
      this.deps.emit({ type: 'done', model: modelId, profile })
      return profile
    } catch (err) {
      this.deps.emit({ type: 'error', model: modelId, message: String(err instanceof Error ? err.message : err) })
      throw err
    } finally {
      rt.launchOverride = null
      this.running = null
      await rt.stop('chat')
      // Back as it was, now with the chosen settings.
      if (wasLoaded) await rt.ensure('chat', modelId).catch(() => undefined)
    }
  }

  /** NETRUNNER's defaults again for this model. */
  reset(modelId: string): void {
    this.deps.profiles.delete(modelId)
  }

  /** After each recorded run: revert a tuned profile when real runs since tuning are clearly slower than before. */
  onRun(model: string): void {
    const p = this.deps.profiles.get(model)
    if (!p || p.status !== 'active' || !Object.keys(p.profile).length || this.deps.interference()) return
    const slower = this.deps.speedsAround(model, p.tunedAt).find(s => shouldRevert(s.before, s.after))
    if (!slower) return
    const reverted: ModelProfile = {
      ...p,
      status: 'reverted',
      note: `Real runs after tuning: median ${median(slower.after).toFixed(1)} tok/s, before: ${median(slower.before).toFixed(1)} tok/s (${slower.after.length} / ${slower.before.length} runs). Reverted to the defaults; they apply at the next model load.`,
    }
    this.deps.profiles.save(reverted)
    this.deps.emit({ type: 'reverted', model, profile: reverted })
  }
}
