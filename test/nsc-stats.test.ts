import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper without types
import { compare, interleave, requiredRuns } from '../tools/nsc/stats.mjs'

describe('NSC-ME comparison statistics', () => {
  it('finds a real 10% slowdown and not a noise-sized one (phase 0 spread, CV ~1%)', () => {
    const a = [22.2, 22.4, 22.4, 22.0, 22.3, 22.1, 22.2, 21.9, 22.1, 22.0] // Coder-Next decode, phase 0
    const slower = a.map(x => x * 0.9)
    const r = compare(a, slower, { tolerancePct: 5 })
    expect(r.effectPct).toBeCloseTo(-10, 5)
    expect(r.significant).toBe(true)
    expect(r.ci95[1]).toBeLessThan(-9)
    expect(r.withinPct).toBe(false)
    // The two loads of phase 0 against each other: −0.9%, detectable at CV 1% but inside ±2% — "significant" is
    // not "matters", so decisions use the tolerance.
    const same = compare(a.slice(0, 5), a.slice(5), { tolerancePct: 2 })
    expect(same.effectPct).toBeCloseTo(-0.9, 1)
    expect(same.withinPct).toBe(true)
  })

  it('is reproducible from its seed', () => {
    const a = [1, 2, 3, 4], b = [2, 3, 4, 5]
    expect(compare(a, b, { seed: 7 })).toEqual(compare(a, b, { seed: 7 }))
  })

  it('sizes the runs from the spread', () => {
    expect(requiredRuns(1.1, 3)).toBe(3) // phase 0: 3 runs see 3%
    expect(requiredRuns(1.1, 2)).toBe(5)
    expect(requiredRuns(15, 10)).toBe(36) // the agent pipeline's ±15% at a 10% tolerance
  })

  it('alternates the order of configurations', () => {
    expect(interleave(['A', 'B'], 3).map((x: { config: string }) => x.config).join('')).toBe('ABBAAB')
  })
})
