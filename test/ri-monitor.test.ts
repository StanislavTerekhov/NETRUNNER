import { describe, expect, it } from 'vitest'
import { assessInterference, ownShares, RI_LIMITS, RiMonitor, type RiSnapshot, speedDrop } from '../electron/main/services/ri-monitor'
import type { RiState } from '../electron/shared/ri'

const GiB = 2 ** 30
// Coder-Next with VRAM limited to half the card (stage 0): weights partly in RAM, 5.5 of 12 GB VRAM, 64 GB RAM.
const base: RiSnapshot = {
  time: 0,
  weightsInRam: true,
  cpuPct: 30,
  ownCpuPct: 21,
  ramAvailableBytes: 20 * GiB,
  ramTotalBytes: 64 * GiB,
  ownRamBytes: 20 * GiB,
  vramUsedBytes: 6.5 * GiB,
  vramTotalBytes: 12 * GiB,
  ownVramBytes: 5.5 * GiB,
  othersVramAtLoadBytes: 1 * GiB,
  gpuPct: 40,
}
const kinds = (s: RiSnapshot) => assessInterference(s).map(f => `${f.kind}:${f.severity}${f.resource ? `:${f.resource}` : ''}`)

describe('reverse interference rules', () => {
  it('reports nothing when the model runs undisturbed', () => {
    expect(kinds(base)).toEqual([])
  })

  it('warns about almost no free RAM only when model weights live in RAM', () => {
    expect(kinds({ ...base, ramAvailableBytes: (RI_LIMITS.ramLowGiB - 0.2) * GiB })).toEqual(['ram-pressure:warn'])
    // 3 GB free cost Coder-Next nothing in the measurement: no warning.
    expect(kinds({ ...base, ramAvailableBytes: 3 * GiB })).toEqual([])
    expect(kinds({ ...base, weightsInRam: false, ramAvailableBytes: 1 * GiB })).toEqual([])
  })

  it('warns when others take VRAM after the model was placed and the card is full', () => {
    // Others went from 0.5 to 6.5 GB after the model was placed, card at 12/12 GB.
    expect(kinds({ ...base, vramUsedBytes: 12 * GiB, othersVramAtLoadBytes: 0.5 * GiB })).toEqual(['vram-others:warn'])
    // The same growth with room left on the card is no problem.
    expect(kinds({ ...base, vramUsedBytes: 9 * GiB, othersVramAtLoadBytes: 0.5 * GiB })).toEqual([])
    // Without nvidia-smi nothing is claimed.
    expect(kinds({ ...base, vramUsedBytes: null, vramTotalBytes: null })).toEqual([])
  })

  it('separates CPU taken by others from NETRUNNER’s own CPU', () => {
    expect(kinds({ ...base, cpuPct: 21 + RI_LIMITS.cpuOthersWarnPct + 1 })).toEqual(['cpu-contention:warn'])
    expect(kinds({ ...base, cpuPct: 21 + RI_LIMITS.cpuOthersCriticalPct + 1 })).toEqual(['cpu-contention:critical'])
    // Busy because of the model itself: not interference.
    expect(kinds({ ...base, cpuPct: 80, ownCpuPct: 75 })).toEqual([])
    // Own CPU not measured yet: no claim.
    expect(kinds({ ...base, cpuPct: 95, ownCpuPct: null })).toEqual([])
  })

  it('shows NETRUNNER’s own shares without judging them (speed comes first)', () => {
    expect(kinds({ ...base, ownRamBytes: 44 * GiB })).toEqual([])
    expect(kinds({ ...base, ownVramBytes: 10.5 * GiB, vramUsedBytes: 11.5 * GiB })).toEqual([])
    expect(ownShares({ ...base, ownVramBytes: 6.5 * GiB }).vram).toBeCloseTo(54.2, 1)
    expect(ownShares(base).gpu).toBeNull()
  })

  it('compares a run with the median of the model’s earlier runs', () => {
    expect(speedDrop('m', 12, [20, 21, 19, 22, 20])).toMatchObject({ kind: 'speed-drop', usual: 20, value: 12 })
    expect(speedDrop('m', 15, [20, 21, 19, 22, 20])).toBeNull()
    // Too little history: no claim.
    expect(speedDrop('m', 5, [20, 21, 19])).toBeNull()
  })
})

describe('RiMonitor', () => {
  it('keeps when a finding started, moves ended findings to the history, and idles without a model', async () => {
    const emitted: RiState[] = []
    let loaded = true
    const mon = new RiMonitor({ footprint: async () => ({ loaded, ownVramBytes: 0, othersVramAtLoadBytes: null, weightsInRam: false, pids: [] }), emit: s => emitted.push(s) })
    mon.onRun('m', 5, [20, 20, 20, 20, 20])
    const since = mon.get().findings[0].since
    expect(mon.get().findings.map(f => f.kind)).toEqual(['speed-drop'])
    mon.onRun('m', 20, [20, 20, 20, 20, 20])
    expect(mon.get().findings).toEqual([])
    expect(since).toBeGreaterThan(0)
    loaded = false
    expect((await mon.sample()).active).toBe(false)
    expect(emitted.length).toBeGreaterThan(0)
  })
})
