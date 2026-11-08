import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../electron/shared/autotune'
import { Autotuner, isBetter, ProfileStore, shouldRevert, tuningAxes, typicalSeconds } from '../electron/main/services/autotune'
import { Database } from '../electron/main/services/db'
import { operatorProfile, serverArgs, shouldUnloadIdle, slotFileTag, type CatalogEntry } from '../electron/main/services/llamacpp'
import path from 'node:path'

const vecPath = path.resolve(import.meta.dirname, '..', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ id: 'm.gguf', name: 'm', files: ['C:\\m\\m.gguf'], sizeBytes: 45 * 2 ** 30, kind: 'chat', expertCount: 512, mtp: false, mmproj: null, ...over }) as CatalogEntry
const GiB = 2 ** 30

describe('autotuner rules', () => {
  it('keeps a candidate only when a typical request gets shorter beyond the noise (measured stage 3 cases)', () => {
    const r = (genTokPerS: number, promptTokPerS: number) => ({ genTokPerS, promptTokPerS, loadMs: 0 })
    // 4B with MTP: 85.8 → 101–105 tok/s, prompt −9…−10%: 4.3 s → 3.7 s.
    expect(isBetter(r(101.1, 2761.8), r(81.8, 3081.3))).toBe(true)
    // 27B, ubatch 1024: 13.2 → 15.8 tok/s.
    expect(isBetter(r(15.8, 552.6), r(13.2, 554.7))).toBe(true)
    // 27B, + MTP: 15.8 → 17.1 tok/s but prompt −14%: 22.6 s → 21.8 s, under 5%.
    expect(isBetter(r(17.1, 475.1), r(15.8, 552.6))).toBe(false)
    // Coder-Next, ubatch 8192: prompt +25%, generation −3.5%: 19.0 s → 18.8 s.
    expect(isBetter(r(19.3, 622.5), r(20, 496.3))).toBe(false)
    // Noise-sized differences are not gains.
    expect(isBetter(r(20.8, 450), r(20, 450))).toBe(false)
    // No trading one speed away for the other.
    expect(isBetter(r(40, 300), r(20, 450))).toBe(false)
    expect(typicalSeconds(r(20, 500))).toBeCloseTo(19, 5)
  })

  it('reverts only on a clear slowdown with enough runs on both sides', () => {
    expect(shouldRevert([20, 21, 20, 19, 20], [15, 16, 15, 16, 15])).toBe(true)
    expect(shouldRevert([20, 21, 20, 19, 20], [18, 19, 18, 19, 18])).toBe(false)
    expect(shouldRevert([20, 21, 20, 19, 20], [10, 10, 10])).toBe(false)
  })

  it('tunes CPU threads only when weights also run on the CPU', () => {
    expect(tuningAxes(entry(), 12 * GiB, 32).map(a => a.key)).toEqual(['moeCacheMib', 'threads', 'ubatch'])
    // GPU expert cache: a third and a half of the VRAM (4 and 6 GB on 12 GB).
    expect(tuningAxes(entry(), 12 * GiB, 32)[0].values).toEqual([4096, 6144])
    expect(tuningAxes(entry(), 12 * GiB, 32)[1].values).toEqual([4, 12, 16]) // 8 is the MoE default
    // A small dense model fully on the GPU: only the batch size.
    expect(tuningAxes(entry({ expertCount: null, sizeBytes: 3 * GiB }), 12 * GiB, 32).map(a => a.key)).toEqual(['ubatch'])
    // MTP head: try the opposite of what NETRUNNER would pick (a 10 GB model fits 12 GB: MTP off by default, so try on).
    expect(tuningAxes(entry({ expertCount: null, sizeBytes: 10 * GiB, mtp: true }), 12 * GiB, 32).find(a => a.key === 'mtp')?.values).toEqual([true])
    expect(tuningAxes(entry({ kind: 'embedding' }), 12 * GiB, 32)).toEqual([])
  })

  it('applies a profile over the defaults in the server arguments', () => {
    const a = serverArgs(entry(), 1, 'k', 65536, 1, { profile: { threads: 12, ubatch: 2048 } })
    expect(a[a.indexOf('-t') + 1]).toBe('12')
    expect(a[a.indexOf('-tb') + 1]).toBe('12')
    expect(a[a.indexOf('-ub') + 1]).toBe('2048')
    expect(a.filter(x => x === '-t')).toHaveLength(1)
    const c = serverArgs(entry(), 1, 'k', 65536, 1, { profile: { moeCacheMib: 6144 } })
    expect(c.join(' ')).toContain('--cpu-moe --moe-cache-mib 6144')
    // No page-locked weights: they would take nearly all of the system's commit (NSC-ME phase 5).
    expect(c).not.toContain('-lm')
    // Dense models have no experts to cache.
    expect(serverArgs(entry({ expertCount: null }), 1, 'k', 16384, 1, { profile: { moeCacheMib: 6144 } })).not.toContain('--cpu-moe')
  })

  it('VRAM saver keeps all experts in RAM without the cache; chat servers can save conversations (NSC-ME)', () => {
    const a = serverArgs(entry(), 1, 'k', 65536, 2, { profile: { cpuMoe: true, moeCacheMib: 6144 } })
    expect(a).toContain('--cpu-moe')
    expect(a).not.toContain('--moe-cache-mib')
    expect(serverArgs(entry({ expertCount: null }), 1, 'k', 16384, 1, { profile: { cpuMoe: true } })).not.toContain('--cpu-moe')
    const s = serverArgs(entry(), 1, 'k', 65536, 2, { slotSavePath: 'C:\\N\\slots' })
    expect(s.join(' ')).toContain('--slot-save-path C:\\N\\slots')
    expect(serverArgs(entry({ kind: 'embedding' }), 1, 'k', 8192, 1, { slotSavePath: 'C:\\N\\slots' })).not.toContain('--slot-save-path')
    // The operator's modes on top of the tuned profile: VRAM saver drops the cache, fast mode adds the expert count.
    expect(operatorProfile({ threads: 12, moeCacheMib: 4096 }, undefined, true)).toEqual({ threads: 12, cpuMoe: true })
    expect(operatorProfile({ ubatch: 2048 }, 8, false)).toEqual({ ubatch: 2048, expertsUsed: 8 })
    expect(operatorProfile(null, undefined, false)).toBeNull()
    expect(operatorProfile(null, 8, true)).toEqual({ expertsUsed: 8, cpuMoe: true })
  })

  it('unloads idle models by size class and under memory pressure (NSC-ME phase 3)', () => {
    const p = { smallMinutes: 10, largeMinutes: 0 }
    const min = 60_000
    expect(shouldUnloadIdle(3 * GiB, 11 * min, p, false)).toBe(true)
    expect(shouldUnloadIdle(3 * GiB, 9 * min, p, false)).toBe(false)
    // Large models stay by default ...
    expect(shouldUnloadIdle(45 * GiB, 600 * min, p, false)).toBe(false)
    expect(shouldUnloadIdle(45 * GiB, 31 * min, { smallMinutes: 10, largeMinutes: 30 }, false)).toBe(true)
    // ... unless RAM runs out and the model has been idle for 2 minutes.
    expect(shouldUnloadIdle(45 * GiB, 3 * min, p, true)).toBe(true)
    expect(shouldUnloadIdle(45 * GiB, 1 * min, p, true)).toBe(false)
    expect(slotFileTag('a/m.gguf', 65536, 2)).toMatch(/^[0-9a-f]{12}-65536x2$/)
    expect(slotFileTag('a/m.gguf', 65536, 2)).not.toBe(slotFileTag('a/m.gguf', 65536, 3))
  })

  it('fast mode overrides the experts used per token, MoE models only (stage 6)', () => {
    const a = serverArgs(entry({ arch: 'qwen3next' }), 1, 'k', 65536, 1, { profile: { expertsUsed: 8 } })
    expect(a.join(' ')).toContain('--override-kv qwen3next.expert_used_count=int:8')
    expect(serverArgs(entry({ arch: 'qwen3next' }), 1, 'k', 65536, 1).join(' ')).not.toContain('expert_used_count')
    expect(serverArgs(entry({ arch: 'qwen35', expertCount: null }), 1, 'k', 16384, 1, { profile: { expertsUsed: 8 } })).not.toContain('--override-kv')
  })
})

describe('profiles and rollback', () => {
  it('stores profiles and reverts an active one when real runs get slower', () => {
    const db = new Database(':memory:', vecPath)
    const profiles = new ProfileStore(db)
    const events: string[] = []
    let slowerAfter = false
    const tuner = new Autotuner({
      runtime: {} as never,
      profiles,
      emit: e => events.push(e.type),
      speedsAround: () => [{ before: [20, 20, 21, 20, 19], after: slowerAfter ? [14, 15, 14, 15, 14] : [21, 22] }],
      interference: () => false,
    })
    const p: ModelProfile = { model: 'm.gguf', profile: { threads: 12 }, status: 'active', tunedAt: '2026-11-04T00:00:00Z', defaults: { genTokPerS: 20, promptTokPerS: 450, loadMs: 0 }, defaultsAgain: null, chosen: { genTokPerS: 22, promptTokPerS: 450, loadMs: 0 }, tried: [], note: null }
    profiles.save(p)
    expect(profiles.active('m.gguf')).toEqual({ threads: 12 })
    tuner.onRun('m.gguf')
    expect(profiles.get('m.gguf')?.status).toBe('active') // too few runs after tuning
    slowerAfter = true
    tuner.onRun('m.gguf')
    expect(profiles.get('m.gguf')?.status).toBe('reverted')
    expect(profiles.active('m.gguf')).toBeNull()
    expect(events).toEqual(['reverted'])
    tuner.reset('m.gguf')
    expect(profiles.get('m.gguf')).toBeNull()
  })

  it('does not blame the profile while something else slows the models down', () => {
    const db = new Database(':memory:', vecPath)
    const profiles = new ProfileStore(db)
    const tuner = new Autotuner({ runtime: {} as never, profiles, emit: () => undefined, speedsAround: () => [{ before: [20, 20, 20, 20, 20], after: [10, 10, 10, 10, 10] }], interference: () => true })
    profiles.save({ model: 'm', profile: { ubatch: 2048 }, status: 'active', tunedAt: 'x', defaults: { genTokPerS: 1, promptTokPerS: 1, loadMs: 0 }, defaultsAgain: null, chosen: { genTokPerS: 1, promptTokPerS: 1, loadMs: 0 }, tried: [], note: null })
    tuner.onRun('m')
    expect(profiles.get('m')?.status).toBe('active')
  })
})
