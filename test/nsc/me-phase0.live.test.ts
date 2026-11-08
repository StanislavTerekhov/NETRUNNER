// NSC-ME phase 0: reproducible baseline and its spread, the reference every later phase is compared with.
// For each model as NETRUNNER runs it (stage 3 profiles: 27B ubatch 1024, 4B MTP; Coder-Next defaults at the agent
// settings), two loads × N reps; each rep = a fixed ~4K-token prefill (1 generated token, no prompt cache) and a
// streamed decode of 300 tokens (inter-token gaps → p50/p95). Prefill/decode order alternates per rep (ABAB).
//   NETRUNNER_LIVE=1 [NSC_MODELS=coder-next,…] [NSC_REPS=5] npx vitest run test/nsc/me-phase0.live.test.ts --silent=false
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LaunchProfile } from '../../electron/shared/autotune'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'
// @ts-expect-error plain ESM helper without types
import { startSampler, summarize } from '../../tools/nsc/sampler.mjs'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'me', 'phase0')
const PROFILES: Record<string, LaunchProfile | null> = {}
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
  getProfile: id => PROFILES[id] ?? null,
})
afterAll(() => runtime.stopAll())

const root = path.resolve(import.meta.dirname, '..', '..')
const longFile = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'web-tools.ts'), 'utf8').slice(0, 15000)
const PREFILL = `${longFile}\n\nQuestion: which function decides that the computer has no internet connection?`
const DECODE = 'Write a TypeScript function that parses a CSV line with quoted fields (commas and escaped quotes inside quotes), then a few unit tests for it. Only the code.'
const MODELS = [
  { id: 'coder-next', match: 'Qwen3-Coder-Next-Q4_K_M-00001', ctx: 65536, parallel: 2, profile: null },
  { id: 'gato-27b-iq3', match: 'Qwen3.8-27B-UD-IQ3_XXS', ctx: 0, parallel: 1, profile: { ubatch: 1024 } },
  { id: 'netrunner-v3-4b', match: 'netrunner-netrunner-v3-Q4_K_M', ctx: 0, parallel: 1, profile: { mtp: true } },
].filter(m => !process.env.NSC_MODELS || process.env.NSC_MODELS.split(',').includes(m.id))
const REPS = Number(process.env.NSC_REPS || 5)
const LOADS = 2

/** Windows memory state: available, standby lists, compression store (counters are in bytes except Available MBytes). */
function memState() {
  const ps = `$c = Get-Counter '\\Memory\\Available MBytes','\\Memory\\Standby Cache Normal Priority Bytes','\\Memory\\Standby Cache Reserve Bytes','\\Memory\\Standby Cache Core Bytes','\\Memory\\Modified Page List Bytes','\\Memory\\Committed Bytes','\\Memory\\Page Reads/sec'
$m = Get-Process -Name 'Memory Compression' -ErrorAction SilentlyContinue
$o = @{}; foreach ($s in $c.CounterSamples) { $o[$s.Path.Split('\\')[-1]] = [math]::Round($s.CookedValue) }
$o['compression bytes'] = if ($m) { $m.WorkingSet64 } else { $null }
$o | ConvertTo-Json -Compress`
  try {
    const r = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })) as Record<string, number>
    const mb = (k: string) => (r[k] == null ? null : Math.round(r[k] / 2 ** 20))
    return {
      availableMiB: r['available mbytes'],
      standbyMiB: (mb('standby cache normal priority bytes') ?? 0) + (mb('standby cache reserve bytes') ?? 0) + (mb('standby cache core bytes') ?? 0),
      modifiedMiB: mb('modified page list bytes'),
      committedMiB: mb('committed bytes'),
      compressionMiB: mb('compression bytes'),
    }
  } catch (e) {
    return { error: String(e) }
  }
}
function gpuState() {
  try {
    const [temp, clock, pstate, used] = execFileSync('nvidia-smi', ['--query-gpu=temperature.gpu,clocks.sm,pstate,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim().split(/,\s*/)
    return { tempC: Number(temp), smMHz: Number(clock), pstate, vramUsedMiB: Number(used) }
  } catch (e) {
    return { error: String(e) }
  }
}

type Srv = { url: string; key: string }
async function prefill(s: Srv, model: string) {
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PREFILL }], temperature: 0, max_tokens: 1, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false }),
  })
  const tm = ((await res.json()) as { timings?: Record<string, number> }).timings ?? {}
  return { promptTokens: tm.prompt_n, promptMs: Math.round(tm.prompt_ms), promptTokPerS: Math.round((tm.prompt_n / tm.prompt_ms) * 10000) / 10 }
}
async function decode(s: Srv, model: string) {
  const t0 = performance.now()
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: DECODE }], temperature: 0, max_tokens: 300, stream: true, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false, timings_per_token: false }),
  })
  const arrivals: number[] = []
  let timings: Record<string, number> = {}
  let pending = ''
  const dec = new TextDecoder()
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const now = performance.now()
    pending += dec.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    let got = false
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      const j = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[]; timings?: Record<string, number> }
      if (j.choices?.[0]?.delta?.content) got = true
      if (j.timings) timings = j.timings
    }
    // Gaps between deliveries, not tokens: with MTP several tokens arrive in one read.
    if (got) arrivals.push(now)
  }
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]).sort((a, b) => a - b)
  const q = (p: number) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] * 10) / 10 : null)
  return {
    ttftMs: arrivals.length ? Math.round(arrivals[0] - t0) : null,
    genTokens: timings.predicted_n,
    genTokPerS: Math.round(timings.predicted_per_second * 10) / 10,
    gapP50Ms: q(0.5),
    gapP95Ms: q(0.95),
    gaps: gaps.length,
  }
}

const stats = (v: number[]) => {
  const n = v.length
  const mean = v.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1))
  return { n, mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 100) / 100, cvPct: Math.round((sd / mean) * 1000) / 10, min: Math.min(...v), max: Math.max(...v) }
}

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME phase 0: baseline spread', () => {
  it('measures prefill and decode spread per model', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const sampler = startSampler(path.join(outDir, `samples-${Date.now()}.jsonl`))
    const report: Record<string, unknown> = { date: new Date().toISOString(), reps: REPS, loads: LOADS, memStart: memState(), gpuStart: gpuState() }
    for (const m of MODELS) {
      const entry = catalog.find(e => e.id.includes(m.match))
      if (!entry) throw new Error(`model not found: ${m.match}`)
      PROFILES[entry.id] = m.profile
      const loads: Record<string, unknown>[] = []
      for (let L = 0; L < LOADS; L++) {
        const memBefore = memState()
        const t0 = Date.now()
        const s = await runtime.ensure('chat', entry.id, m.ctx, m.parallel)
        const loadMs = Date.now() - t0
        const memLoaded = memState()
        await prefill(s, entry.id) // warm-up, not counted
        await decode(s, entry.id)
        const reps: Record<string, unknown>[] = []
        for (let r = 0; r < REPS; r++) {
          const order = r % 2 === 0 ? ['prefill', 'decode'] : ['decode', 'prefill']
          const rep: Record<string, unknown> = { order: order.join('>'), gpu: gpuState() }
          for (const k of order) rep[k] = k === 'prefill' ? await prefill(s, entry.id) : await decode(s, entry.id)
          reps.push(rep)
          console.log(`[me0] ${m.id} load${L} rep${r} ${JSON.stringify(rep)}`)
        }
        loads.push({ loadMs, memBefore, memLoaded, resources: summarize(sampler.samples, t0, Date.now()), reps })
        await runtime.stopAll()
        await new Promise(r => setTimeout(r, 3000))
      }
      const all = loads.flatMap(l => l.reps as { prefill: { promptTokPerS: number; promptMs: number }; decode: { genTokPerS: number; ttftMs: number; gapP95Ms: number } }[])
      const perLoad = loads.map(l => stats((l.reps as typeof all).map(r => r.decode.genTokPerS)).mean)
      const summary = {
        model: entry.id,
        profile: m.profile,
        loadMs: loads.map(l => l.loadMs),
        prefillTokPerS: stats(all.map(r => r.prefill.promptTokPerS)),
        prefillMs: stats(all.map(r => r.prefill.promptMs)),
        decodeTokPerS: stats(all.map(r => r.decode.genTokPerS)),
        decodeMeanPerLoad: perLoad,
        ttftMs: stats(all.map(r => r.decode.ttftMs)),
        gapP95Ms: stats(all.map(r => r.decode.gapP95Ms)),
      }
      report[m.id] = { summary, loads }
      console.log(`[me0] ${m.id} SUMMARY ${JSON.stringify(summary)}`)
    }
    await sampler.stop()
    report.memEnd = memState()
    report.gpuEnd = gpuState()
    fs.writeFileSync(path.join(outDir, `phase0-${MODELS.map(m => m.id).join('+')}.json`), JSON.stringify(report, null, 2))
    expect(MODELS.every(m => report[m.id])).toBe(true)
  }, 120 * 60_000)
})
