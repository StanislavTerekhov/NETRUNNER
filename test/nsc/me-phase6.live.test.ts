// NSC-ME phase 6 (H1, VRAM elasticity): how much video memory a model can give to other programs and at what price.
// The lever is stock llama.cpp: --fit-target (MiB of VRAM --fit leaves free; NETRUNNER uses the default 1024), and
// for MoE --cpu-moe (all experts in RAM) with or without the GPU expert cache. Per configuration (one load):
//   3 reps of a fixed 4264-token prefill + a 300-token streamed decode (phase 0 method);
//   co-existence: a VRAM Memory Consumer holds the VRAM that is left (and, for two configurations, a fixed 3 GiB)
//   and touches it every 250 ms while the model decodes — both sides measured;
//   CPU contention (two configurations): an 8-thread CPU Consumer next to the decode — both sides measured.
//   NETRUNNER_LIVE=1 [NSC_CONFIGS=id,…] npx vitest run test/nsc/me-phase6.live.test.ts --silent=false
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LaunchProfile } from '../../electron/shared/autotune'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'me', 'phase6')
const bin = path.join(home, 'nsc', 'me', 'phase1', 'bin')
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

type Cfg = { id: string; model: 'cn' | '27b'; extra: string; profile?: LaunchProfile; ctx?: number; fixed3?: boolean; cpu?: boolean }
const CN = 'Qwen3-Coder-Next-Q4_K_M-00001', G27 = 'Qwen3.8-27B-UD-IQ3_XXS'
const CONFIGS: Cfg[] = [
  { id: 'cn-fit1024', model: 'cn', extra: '', fixed3: true, cpu: true },
  { id: 'cn-fit3072', model: 'cn', extra: '--fit-target 3072' },
  { id: 'cn-fit5120', model: 'cn', extra: '--fit-target 5120' },
  { id: 'cn-fit7168', model: 'cn', extra: '--fit-target 7168' },
  { id: 'cn-cpumoe', model: 'cn', extra: '--cpu-moe', fixed3: true, cpu: true },
  { id: 'cn-cpumoe-ctx32k', model: 'cn', extra: '--cpu-moe', ctx: 32768 },
  // Partial: experts of the first N of 48 layers in RAM, the rest and all non-expert weights on the GPU.
  { id: 'cn-ncmoe36', model: 'cn', extra: '--n-cpu-moe 36' },
  { id: 'cn-ncmoe42', model: 'cn', extra: '--n-cpu-moe 42' },
  { id: 'cn-cache2048', model: 'cn', extra: '', profile: { moeCacheMib: 2048 } },
  { id: 'cn-cache4096', model: 'cn', extra: '', profile: { moeCacheMib: 4096 } },
  { id: '27b-fit1024', model: '27b', extra: '' },
  { id: '27b-fit3072', model: '27b', extra: '--fit-target 3072' },
  { id: '27b-fit5120', model: '27b', extra: '--fit-target 5120' },
]
// NSC_ORDER=a,b,a,b runs configurations in that order (repeats allowed: load-to-load spread); NSC_QUICK=1 skips the
// co-existence and CPU checks.
const ORDER: Cfg[] = process.env.NSC_ORDER
  ? process.env.NSC_ORDER.split(',').map(id => CONFIGS.find(c => c.id === id) ?? (() => { throw new Error(`unknown config ${id}`) })())
  : CONFIGS.filter(c => !process.env.NSC_CONFIGS || process.env.NSC_CONFIGS.split(',').includes(c.id))
const QUICK = process.env.NSC_QUICK === '1'

const vramUsed = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim())
function availableMiB() {
  return Number(execFileSync('powershell', ['-NoProfile', '-Command', "[math]::Round((Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue)"], { encoding: 'utf8', windowsHide: true }).trim())
}
type Srv = { url: string; key: string }
async function prefill(s: Srv, model: string) {
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PREFILL }], temperature: 0, max_tokens: 1, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false }),
  })
  const tm = ((await res.json()) as { timings?: Record<string, number> }).timings ?? {}
  return Math.round((tm.prompt_n / tm.prompt_ms) * 10000) / 10
}
async function decode(s: Srv, model: string) {
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: DECODE }], temperature: 0, max_tokens: 300, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false }),
  })
  const tm = ((await res.json()) as { timings?: Record<string, number> }).timings ?? {}
  return Math.round(tm.predicted_per_second * 10) / 10
}
/** Start a consumer in the background; resolves with its JSON lines when it exits. */
function background(exe: string, args: string[]) {
  const p = spawn(path.join(bin, exe), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  p.stdout.on('data', d => (out += d.toString()))
  return new Promise<Record<string, number | string>[]>(r => p.on('close', () => r(out.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)))))
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

/** A VRAM consumer holds `gib` while the model decodes once. */
async function coexist(s: Srv, model: string, gib: number) {
  const done = background('vramconsumer.exe', [String(gib), '0', '--hold-seconds', '28', '--interval-ms', '250'])
  await pause(4000)
  const t0 = Date.now()
  const tok = await decode(s, model)
  const during = (Date.now() - t0) / 1000
  const lines = await done
  const alloc = lines.find(l => l.phase === 'alloc')
  const passes = lines.filter(l => l.pass) as { t: number; GBps: number }[]
  // Passes that ran while the model decoded (consumer clock starts ~4 s before the decode).
  const inWindow = passes.filter(p => p.t >= 3.5 && p.t <= 4 + during + 0.5).map(p => p.GBps)
  return { gib, modelTokPerS: tok, consumerAllocGiB: alloc?.GiB ?? null, consumerError: (lines.find(l => l.error)?.error as string) ?? null, consumerMedianGBps: inWindow.length ? med(inWindow) : null, consumerMinGBps: inWindow.length ? Math.min(...inWindow) : null, passes: inWindow.length }
}
async function cpuContention(s: Srv, model: string) {
  const alone = (await background('memconsumer.exe', ['cpu', '8', '5'])).map(l => Number(l.seconds))
  const done = background('memconsumer.exe', ['cpu', '8', '24'])
  await pause(1000)
  const tok = await decode(s, model)
  const lines = (await done).map(l => Number(l.seconds))
  return { consumerAloneS: med(alone), consumerWithModelS: med(lines.slice(1, -2)), modelTokPerS: tok }
}

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME phase 6: VRAM elasticity', () => {
  it('builds the VRAM ↔ speed curve with real co-existence checks', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const ids = { cn: catalog.find(e => e.id.includes(CN))!.id, '27b': catalog.find(e => e.id.includes(G27))!.id }
    await runtime.stopAll()
    await pause(3000)
    const base = { vramMiB: vramUsed(), availableMiB: availableMiB() }
    const report: Record<string, unknown> = { date: new Date().toISOString(), base }
    for (const [i, c] of ORDER.entries()) {
      const id = ids[c.model]
      PROFILES[id] = { ...(c.model === '27b' ? { ubatch: 1024 } : {}), ...(c.profile ?? {}) }
      if (c.extra) process.env.NETRUNNER_SERVER_EXTRA_ARGS = c.extra
      else delete process.env.NETRUNNER_SERVER_EXTRA_ARGS
      const t = Date.now()
      const s = await runtime.ensure('chat', id, c.model === 'cn' ? (c.ctx ?? 65536) : 0, c.model === 'cn' ? 2 : 1)
      const loadMs = Date.now() - t
      await prefill(s, id)
      await decode(s, id)
      const used = vramUsed() - base.vramMiB
      const ramHeld = base.availableMiB - availableMiB()
      const pre: number[] = [], dec: number[] = []
      for (let r = 0; r < 3; r++) {
        pre.push(await prefill(s, id))
        dec.push(await decode(s, id))
      }
      const left = Math.floor((12288 - vramUsed() - 400) / 256) / 4
      const co = !QUICK && left >= 0.25 ? [await coexist(s, id, left)] : []
      if (!QUICK && c.fixed3) co.push(await coexist(s, id, 3))
      const cpu = !QUICK && c.cpu ? await cpuContention(s, id) : null
      await runtime.stopAll()
      await pause(3000)
      const row = { loadMs, modelVramMiB: used, ramHeldMiB: ramHeld, prefillTokPerS: pre, decodeTokPerS: dec, coexist: co, cpu }
      report[`${c.id}#${i}`] = row
      console.log(`[me6] ${c.id}#${i} ${JSON.stringify(row)}`)
    }
    delete process.env.NETRUNNER_SERVER_EXTRA_ARGS
    fs.writeFileSync(path.join(outDir, `phase6-${Date.now()}.json`), JSON.stringify(report, null, 2))
    expect(ORDER.every((c, i) => report[`${c.id}#${i}`])).toBe(true)
  }, 180 * 60_000)
})
