// NSC-ME phase 5 (H3 honestly): another program really uses the memory, then the model is needed again.
// Scenarios (Coder-Next at agent settings unless noted):
//   unload-16 / unload-28  unload → Memory Consumer commits and touches 16 / 28 GiB, exits → load → first answer
//   loaded-28             model stays loaded (mmap) → Consumer 28 GiB → first answer (standard OS elasticity)
//   27b-loaded-28         same with Qwen 27B (fully on GPU; its mmap copy of the file is not needed after load)
//   pinned                -lm none + 6 GB expert cache (the chat profile): commit headroom left to others, and
//                         the return after an unload (re-pinning)
// The Consumer never commits more than (commit limit − committed − 4 GiB): the pagefile here is system-managed
// (4 GB), and going over the limit would grow it or fail other programs' allocations.
//   NETRUNNER_LIVE=1 [NSC_REPS=3] [NSC_SCENARIOS=…] npx vitest run test/nsc/me-phase5.live.test.ts --silent=false
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LaunchProfile } from '../../electron/shared/autotune'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'me', 'phase5')
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
const REPS = Number(process.env.NSC_REPS || 3)
const only = (id: string) => !process.env.NSC_SCENARIOS || process.env.NSC_SCENARIOS.split(',').includes(id)
const GiB = 2 ** 30

function sys() {
  const ps = `$o = Get-CimInstance Win32_OperatingSystem; $p = Get-CimInstance Win32_PageFileUsage; $c = Get-Counter '\\Memory\\Available MBytes','\\Memory\\Committed Bytes','\\Memory\\Commit Limit'
$h = @{}; foreach ($s in $c.CounterSamples) { $h[$s.Path.Split('\\')[-1]] = [math]::Round($s.CookedValue) }
@{ available = $h['available mbytes']; committed = $h['committed bytes']; limit = $h['commit limit']; pagefileAllocMB = ($p | Measure-Object AllocatedBaseSize -Sum).Sum; pagefileUsedMB = ($p | Measure-Object CurrentUsage -Sum).Sum } | ConvertTo-Json -Compress`
  const r = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })) as Record<string, number>
  return {
    availableGiB: Math.round((r.available / 1024) * 10) / 10,
    committedGiB: Math.round((r.committed / GiB) * 10) / 10,
    commitLimitGiB: Math.round((r.limit / GiB) * 10) / 10,
    pagefileAllocMB: r.pagefileAllocMB,
    pagefileUsedMB: r.pagefileUsedMB,
  }
}
/** Memory Consumer, capped by the commit headroom. */
function consumer(wantGiB: number) {
  const s = sys()
  const gib = Math.min(wantGiB, Math.floor(s.commitLimitGiB - s.committedGiB - 4))
  if (gib < 1) return { wantGiB, gib: 0, skipped: 'no commit headroom', before: s }
  const t = Date.now()
  const lines = execFileSync(path.join(bin, 'memconsumer.exe'), ['ram', String(gib), '3'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().split(/\r?\n/).map(l => JSON.parse(l) as { phase?: string; pass?: number; seconds?: number; GBps?: number; faults?: number; error?: string })
  const touch = lines.find(l => l.phase === 'touch')
  const passes = lines.filter(l => l.pass)
  return {
    wantGiB, gib, before: s, wallMs: Date.now() - t,
    touchSeconds: touch?.seconds ?? null, touchGBps: touch?.GBps ?? null,
    passGBps: passes.map(p => p.GBps), passFaults: passes.map(p => p.faults),
    error: lines.find(l => l.error)?.error ?? null,
  }
}
async function answer(s: { url: string; key: string }, model: string) {
  const t0 = Date.now()
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Write a TypeScript function that checks whether a string is a palindrome, ignoring case and spaces.' }], max_tokens: 64, temperature: 0, cache_prompt: false, chat_template_kwargs: { enable_thinking: false } }),
  })
  const tm = ((await res.json()) as { timings?: Record<string, number> }).timings ?? {}
  return { wallMs: Date.now() - t0, promptMs: Math.round(tm.prompt_ms), genTokPerS: Math.round(tm.predicted_per_second * 10) / 10 }
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME phase 5: honest idle', () => {
  it('measures the return after another program used the memory', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const cn = catalog.find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))!.id
    const g27 = catalog.find(e => e.id.includes('Qwen3.8-27B-UD-IQ3_XXS'))!.id
    PROFILES[g27] = { ubatch: 1024 }
    const report: Record<string, unknown> = { date: new Date().toISOString(), start: sys() }
    const log = (k: string, v: unknown) => console.log(`[me5] ${k} ${JSON.stringify(v)}`)
    await runtime.stopAll()

    const loadAnswer = async (id: string, ctx: number, np: number) => {
      const t = Date.now()
      const s = await runtime.ensure('chat', id, ctx, np)
      const loadMs = Date.now() - t
      const a = await answer(s, id)
      return { loadMs, ...a, totalMs: Date.now() - t }
    }

    for (const want of [16, 28]) {
      const id = `unload-${want}`
      if (!only(id)) continue
      const reps = []
      for (let r = 0; r < REPS; r++) {
        // Warm start: weights in standby, then unload.
        await loadAnswer(cn, 65536, 2)
        await runtime.stopAll()
        await pause(2000)
        const c = consumer(want)
        await pause(2000)
        const back = await loadAnswer(cn, 65536, 2)
        const second = await answer((await runtime.ensure('chat', cn, 65536, 2)), cn)
        await runtime.stopAll()
        reps.push({ consumer: c, back, second })
        log(`${id} rep${r}`, { consumerGiB: c.gib, touchGBps: c.touchGBps, back, second })
        await pause(2000)
      }
      report[id] = reps
    }

    for (const [id, model, ctx, np] of [['loaded-28', cn, 65536, 2], ['27b-loaded-28', g27, 0, 1]] as const) {
      if (!only(id)) continue
      const reps = []
      for (let r = 0; r < REPS; r++) {
        const s = await runtime.ensure('chat', model, ctx, np)
        const before = await answer(s, model)
        const c = consumer(28)
        await pause(2000)
        const after = await answer(s, model)
        const again = await answer(s, model)
        await runtime.stopAll()
        reps.push({ before, consumer: c, after, again })
        log(`${id} rep${r}`, { before, consumerGiB: c.gib, consumerCommitBefore: c.before, touchGBps: c.touchGBps, passGBps: (c as { passGBps?: unknown }).passGBps, after, again })
        await pause(3000)
      }
      report[id] = reps
    }

    if (only('pinned')) {
      PROFILES[cn] = { moeCacheMib: 6144 }
      const t = Date.now()
      const s = await runtime.ensure('chat', cn, 65536, 2)
      const loadMs = Date.now() - t
      const loaded = sys()
      const before = await answer(s, cn)
      const c = consumer(16)
      const after = await answer(s, cn)
      await runtime.stopAll()
      await pause(2000)
      const c2 = consumer(16)
      const back = await loadAnswer(cn, 65536, 2)
      await runtime.stopAll()
      PROFILES[cn] = null
      report.pinned = { loadMs, loaded, before, consumerLoaded: c, after, consumerUnloaded: c2, back }
      log('pinned', report.pinned)
    }
    report.end = sys()
    fs.writeFileSync(path.join(outDir, `phase5-${Date.now()}.json`), JSON.stringify(report, null, 2))
    expect(report.end).toBeTruthy()
  }, 120 * 60_000)
})
