// NSC-ME phase 3 (H4, whole-model elasticity): what unloading an idle model really gives other programs, and what
// getting it back costs. Per model as NETRUNNER runs it:
//   1. memory before load / loaded and idle / after unload (Windows counters + nvidia-smi, all processes);
//   2. Memory Consumer (RAM 16 GiB, VRAM 6 GiB) next to the idle model and after its unload;
//   3. warm return: unload → load → first token, 3 times (weights in standby; cold = phase 1 disk speed);
//   4. switching 27B ↔ Coder-Next: request to the other model → first token, 3 each way.
//   NETRUNNER_LIVE=1 [NSC_MODELS=…] npx vitest run test/nsc/me-phase3.live.test.ts --silent=false
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LaunchProfile } from '../../electron/shared/autotune'
import { findRuntimeDir, LlamaRuntime, type Slot } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'me', 'phase3')
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

const MODELS = [
  { id: 'coder-next', match: 'Qwen3-Coder-Next-Q4_K_M-00001', slot: 'chat' as Slot, ctx: 65536, parallel: 2, profile: null },
  { id: 'gato-27b-iq3', match: 'Qwen3.8-27B-UD-IQ3_XXS', slot: 'chat' as Slot, ctx: 0, parallel: 1, profile: { ubatch: 1024 } },
  { id: 'netrunner-v3-4b', match: 'netrunner-netrunner-v3-Q4_K_M', slot: 'chat' as Slot, ctx: 0, parallel: 1, profile: { mtp: true } },
  { id: 'embedding-0.6b', match: 'Qwen3-Embedding-0.6B', slot: 'embed' as Slot, ctx: 0, parallel: 1, profile: null },
].filter(m => !process.env.NSC_MODELS || process.env.NSC_MODELS.split(',').includes(m.id))

function mem() {
  const ps = `$c = Get-Counter '\\Memory\\Available MBytes','\\Memory\\Committed Bytes','\\Memory\\Standby Cache Normal Priority Bytes','\\Memory\\Standby Cache Reserve Bytes','\\Memory\\Standby Cache Core Bytes'
$o = @{}; foreach ($s in $c.CounterSamples) { $o[$s.Path.Split('\\')[-1]] = [math]::Round($s.CookedValue) }; $o | ConvertTo-Json -Compress`
  const r = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })) as Record<string, number>
  const mb = (k: string) => Math.round((r[k] ?? 0) / 2 ** 20)
  const vram = Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim())
  return {
    availableMiB: r['available mbytes'],
    committedMiB: mb('committed bytes'),
    standbyMiB: mb('standby cache normal priority bytes') + mb('standby cache reserve bytes') + mb('standby cache core bytes'),
    vramUsedMiB: vram,
  }
}

/** Run a Memory Consumer and reduce its passes to median / min GB/s (and faults for RAM). */
function consumer(kind: 'ram' | 'vram') {
  const args = kind === 'ram' ? ['ram', '16', '5'] : ['6', '30']
  const exe = path.join(bin, kind === 'ram' ? 'memconsumer.exe' : 'vramconsumer.exe')
  const lines = execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().split(/\r?\n/).map(l => JSON.parse(l) as { pass?: number; GBps?: number; faults?: number; error?: string; freeBeforeGiB?: number })
  const passes = lines.filter(l => l.pass)
  const g = passes.map(p => p.GBps ?? 0).sort((a, b) => a - b)
  return {
    kind,
    medianGBps: g[Math.floor(g.length / 2)] ?? null,
    minGBps: g[0] ?? null,
    faults: passes.reduce((n, p) => n + (p.faults ?? 0), 0),
    error: lines.find(l => l.error)?.error ?? null,
    reportedFreeGiB: lines.find(l => l.freeBeforeGiB != null)?.freeBeforeGiB ?? null,
  }
}

async function firstToken(slot: Slot, model: string, s: { url: string; key: string }) {
  const t0 = Date.now()
  if (slot === 'embed') {
    await fetch(`${s.url}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` }, body: JSON.stringify({ model, input: 'ok' }) })
  } else {
    await fetch(`${s.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Ответь одним словом: да или нет?' }], max_tokens: 1, chat_template_kwargs: { enable_thinking: false } }),
    })
  }
  return Date.now() - t0
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME phase 3: whole-model elasticity', () => {
  it('measures what unloading gives and what returning costs', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const catalog = await runtime.catalog.list()
    const ids: Record<string, string> = {}
    for (const m of MODELS) {
      const e = catalog.find(x => x.id.includes(m.match))
      if (!e) throw new Error(`model not found: ${m.match}`)
      ids[m.id] = e.id
      PROFILES[e.id] = m.profile
    }
    await runtime.stopAll()
    await pause(3000)
    const report: Record<string, unknown> = { date: new Date().toISOString(), empty: mem(), consumersEmpty: [consumer('ram'), consumer('vram')] }
    console.log(`[me3] empty ${JSON.stringify(report.empty)} ${JSON.stringify(report.consumersEmpty)}`)
    for (const m of MODELS) {
      const id = ids[m.id]
      const before = mem()
      const t0 = Date.now()
      const s = await runtime.ensure(m.slot, id, m.ctx, m.parallel)
      const loadMs = Date.now() - t0
      const ttftMs = await firstToken(m.slot, id, s)
      await pause(5000)
      const idle = mem()
      const consumersLoaded = [consumer('ram'), consumer('vram')]
      await runtime.stop(m.slot)
      await pause(3000)
      const after = mem()
      const consumersUnloaded = [consumer('ram'), consumer('vram')]
      // Warm return: weights still in standby.
      const returns: { loadMs: number; ttftMs: number }[] = []
      for (let r = 0; r < 3; r++) {
        const a = Date.now()
        const s2 = await runtime.ensure(m.slot, id, m.ctx, m.parallel)
        const l = Date.now() - a
        returns.push({ loadMs: l, ttftMs: await firstToken(m.slot, id, s2) })
        await runtime.stop(m.slot)
        await pause(2000)
      }
      const d = (k: keyof typeof before) => idle[k] - before[k]
      report[m.id] = {
        model: id, first: { loadMs, ttftMs }, before, idle, after,
        held: { availableMiB: -d('availableMiB'), committedMiB: d('committedMiB'), vramMiB: d('vramUsedMiB') },
        freedByUnload: { availableMiB: after.availableMiB - idle.availableMiB, committedMiB: idle.committedMiB - after.committedMiB, vramMiB: idle.vramUsedMiB - after.vramUsedMiB },
        consumersLoaded, consumersUnloaded, returns,
      }
      console.log(`[me3] ${m.id} ${JSON.stringify({ held: (report[m.id] as { held: unknown }).held, freed: (report[m.id] as { freedByUnload: unknown }).freedByUnload, consumersLoaded, consumersUnloaded, returns })}`)
    }
    // Switching between the two big chat models, as NETRUNNER does it (the chat slot swaps).
    const a = MODELS.find(m => m.id === 'gato-27b-iq3'), b = MODELS.find(m => m.id === 'coder-next')
    if (a && b) {
      const sw: { to: string; ms: number }[] = []
      await runtime.ensure('chat', ids[a.id], a.ctx, a.parallel)
      for (let r = 0; r < 3; r++) {
        for (const to of [b, a]) {
          const t = Date.now()
          const s = await runtime.ensure('chat', ids[to.id], to.ctx, to.parallel)
          await firstToken('chat', ids[to.id], s)
          sw.push({ to: to.id, ms: Date.now() - t })
        }
      }
      await runtime.stopAll()
      report.switching = sw
      console.log(`[me3] switching ${JSON.stringify(sw)}`)
    }
    fs.writeFileSync(path.join(outDir, `phase3-${MODELS.map(m => m.id).join('+')}.json`), JSON.stringify(report, null, 2))
    expect(MODELS.every(m => report[m.id])).toBe(true)
  }, 90 * 60_000)
})
