// NETRUNNER mark: a ring woven from N ribbons. Each ribbon runs along the ring, then leaves it tangentially and
// crosses inside to rejoin the ring further on — the gaps between ring and inner curves become lens shapes.
// The colour runs along each ribbon (drawn as many short overlapping segments), dark where a ribbon emerges from
// under its neighbour, bright where it lies on top.
//   node tools/icon/mark.mjs <out.svg> [palette] [folds] [innerSpan]
import fs from 'node:fs'

export const PALETTES = {
  // NETRUNNER theme: --color-secondary #00e5ff, --color-success #19f5a5, --color-primary #fcee09, --color-void #07090b
  'cyan-green': ['#021c23', '#04576a', '#00b4d0', '#19f5a5', '#b8ffe0'],
  'green-yellow': ['#03201a', '#0a6b4c', '#12c98a', '#19f5a5', '#e9f77a'],
  'cyan-yellow': ['#021c23', '#04576a', '#00c2e0', '#7ff0b0', '#fcee09'],
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (stops, t) => {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  const a = hex(stops[i]), b = hex(stops[i + 1]), f = x - i
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('')
}

export function mark({ palette = 'cyan-green', folds = 3, minor = 0.55, peak = 1, width = 0.12, size = 1024, background = true, crop = false } = {}) {
  const stops = PALETTES[palette]
  const c = size / 2
  const r = size * 0.31 // ring centre line
  const w = size * width // ribbon width
  const outerSpan = 360 / folds
  const P = a => [c + r * Math.cos((a * Math.PI) / 180), c + r * Math.sin((a * Math.PI) / 180)]
  const T = a => [-Math.sin((a * Math.PI) / 180), Math.cos((a * Math.PI) / 180)] // clockwise tangent
  // The ring is lit from the top left: one stroke with a linear gradient along the light direction (the tone is
  // linear in that projection), so it has no seams.
  const ringTone = a => 0.3 + 0.2 * Math.cos(((a - 225) * Math.PI) / 180)
  const L = [Math.cos((225 * Math.PI) / 180), Math.sin((225 * Math.PI) / 180)]
  const ringStops = Array.from({ length: 9 }, (_, k) => `<stop offset="${k / 8}" stop-color="${mix(stops, ringTone(225) - (0.4 * k) / 8)}"/>`).join('')
  const ring = `<linearGradient id="lit" gradientUnits="userSpaceOnUse" x1="${c + L[0] * r}" y1="${c + L[1] * r}" x2="${c - L[0] * r}" y2="${c - L[1] * r}">${ringStops}</linearGradient><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="url(#lit)" stroke-width="${w}"/>`
  // Each crossing is the front half of a great circle of the sphere the ring outlines: a half ellipse from one point
  // of the ring to the opposite one, tangent to the ring at both ends (smooth merge, no cusps while the ellipse's
  // tightest bend b²/r stays wider than half the band). Its tone starts and ends at the ring's tone there and peaks
  // in the middle; depth comes from the shadow each crossing casts.
  const f = v => v.toFixed(1)
  const b = r * minor
  const N = 240
  const crossing = i => {
    const phi = -90 + (i + 1) * outerSpan, pr = (phi * Math.PI) / 180
    const at = th => [c + r * Math.cos(th) * Math.cos(pr) - b * Math.sin(th) * Math.sin(pr), c + r * Math.cos(th) * Math.sin(pr) + b * Math.sin(th) * Math.cos(pr)]
    const pts = Array.from({ length: N + 1 }, (_, k) => at((Math.PI * k) / N))
    // Tone of a point: the ring's light at its angle, brightened by how deep inside the ring it lies, so the ends match
    // the ring they merge into exactly.
    const depthMax = 1 - b / r
    const tone = p => {
      const dx = p[0] - c, dy = p[1] - c
      const depth = Math.min(1, (1 - Math.hypot(dx, dy) / r) / depthMax)
      const base = ringTone((Math.atan2(dy, dx) * 180) / Math.PI)
      return base + (peak - base) * Math.sqrt(Math.max(depth, 0))
    }
    const path = (lo, hi, extra) => `<path d="M${pts.slice(lo, hi + 1).map(p => f(p[0]) + ' ' + f(p[1])).join('L')}" fill="none" ${extra}/>`
    return {
      // Shadow along the middle only: at the ends the band lies flat on the ring.
      shadow: path(Math.round(N * 0.3), Math.round(N * 0.7), `stroke="#000" stroke-opacity="0.65" stroke-width="${f(w * 1.3)}" stroke-linecap="round"`),
      half: (lo, hi) => Array.from({ length: hi - lo }, (_, k) => path(lo + k, Math.min(lo + k + 2, hi), `stroke="${mix(stops, tone(pts[lo + k]))}" stroke-width="${f(w)}" stroke-linecap="butt" stroke-linejoin="round"`)).join(''),
    }
  }
  const xs = Array.from({ length: folds }, (_, i) => crossing(i))
  // Weave: the first halves of all crossings go down first, the second halves on top, so each crossing passes over
  // one neighbour and under the other.
  const H = N / 2
  const body = ring +
    xs.map(x => `<g filter="url(#soft)">${x.shadow}</g>`).join('') + xs.map(x => x.half(0, H + 1)).join('') +
    xs.map(x => x.half(H, N)).join('')
  const rr = size * 0.22
  const bg = background
    ? `<defs><radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#161c20"/><stop offset="1" stop-color="#07090b"/></radialGradient></defs>
<rect x="${size * 0.02}" y="${size * 0.02}" width="${size * 0.96}" height="${size * 0.96}" rx="${rr}" fill="url(#bg)"/>
<rect x="${size * 0.02 + 2}" y="${size * 0.02 + 2}" width="${size * 0.96 - 4}" height="${size * 0.96 - 4}" rx="${rr - 2}" fill="none" stroke="#34404a" stroke-width="4"/>`
    : ''
    // crop: the mark alone, edge to edge (for 16–48 px, where a tile would leave only a speck).
  const m = r + w / 2 + size * 0.01, vb = crop ? `${f(c - m)} ${f(c - m)} ${f(2 * m)} ${f(2 * m)}` : `0 0 ${size} ${size}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}">${crop ? '' : bg}
<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${size * 0.018}"/></filter><clipPath id="ring"><circle cx="${c}" cy="${c}" r="${r + w / 2}"/></clipPath><g clip-path="url(#ring)">${body}</g></svg>`
}

