// NSC-ME: statistics for configuration comparisons (phase 2 stand). Plain ESM, no dependencies.

/** Deterministic PRNG (mulberry32) so a bootstrap interval is reproducible from its seed. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = v => v.reduce((x, y) => x + y, 0) / v.length

/**
 * Relative effect of B against A: mean(B)/mean(A) − 1, in percent, with a percentile bootstrap 95 % interval.
 * `significant` = the interval excludes 0; `withinPct` = the whole interval lies inside ±tolerance.
 */
export function compare(a, b, { iters = 10000, seed = 1, tolerancePct = null } = {}) {
  if (a.length < 2 || b.length < 2) throw new Error('need at least 2 runs per configuration')
  const r = rng(seed)
  const pick = v => v[Math.floor(r() * v.length)]
  const d = []
  for (let i = 0; i < iters; i++) {
    let sa = 0, sb = 0
    for (let k = 0; k < a.length; k++) sa += pick(a)
    for (let k = 0; k < b.length; k++) sb += pick(b)
    d.push((sb / b.length / (sa / a.length) - 1) * 100)
  }
  d.sort((x, y) => x - y)
  const lo = d[Math.floor(iters * 0.025)], hi = d[Math.floor(iters * 0.975)]
  const effect = (mean(b) / mean(a) - 1) * 100
  const round = x => Math.round(x * 100) / 100
  return {
    meanA: round(mean(a)),
    meanB: round(mean(b)),
    effectPct: round(effect),
    ci95: [round(lo), round(hi)],
    significant: lo > 0 || hi < 0,
    withinPct: tolerancePct == null ? null : lo >= -tolerancePct && hi <= tolerancePct,
  }
}

/** Runs per configuration to see a `deltaPct` difference at a given coefficient of variation (α 0.05, power 0.8). */
export function requiredRuns(cvPct, deltaPct) {
  return Math.max(2, Math.ceil(2 * (1.96 + 0.8416) ** 2 * (cvPct / deltaPct) ** 2))
}

/** Interleaved order for comparing configurations: ABC, CBA, ABC, … — cancels slow drift (heat, background). */
export function interleave(configs, reps) {
  const out = []
  for (let r = 0; r < reps; r++) for (const c of r % 2 === 0 ? configs : [...configs].reverse()) out.push({ rep: r, config: c })
  return out
}
