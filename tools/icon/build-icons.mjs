// Builds NETRUNNER's icons from the mark: build/icon.ico + build/icon.png (installer, exe, shortcut),
// public/favicon.ico (window), public/mark.png (title bar).
//   node tools/icon/build-icons.mjs
// 16–48 px use the mark alone, edge to edge; 64 px and up the mark on its dark tile.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mark } from './mark.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-icon-'))
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const opts = { palette: 'cyan-green' }
fs.writeFileSync(path.join(tmp, 'tile.svg'), mark(opts))
fs.writeFileSync(path.join(tmp, 'bare.svg'), mark({ ...opts, crop: true }))

const render = (size, svg) => {
  const out = path.join(tmp, `${size}.png`)
  execFileSync(electron, [path.join(import.meta.dirname, 'render.cjs'), String(size), path.join(tmp, svg), out], { stdio: 'inherit' })
  return fs.readFileSync(out)
}
const sizes = [16, 24, 32, 48, 64, 128, 256]
execFileSync(electron, [path.join(import.meta.dirname, 'render.cjs'), '64', path.join(tmp, 'bare.svg'), path.join(tmp, 'bare64.png')], { stdio: 'inherit' })
const pngs = sizes.map(s => ({ s, png: render(s, s <= 48 ? 'bare.svg' : 'tile.svg') }))

// ICO with PNG entries (Vista+).
const ico = entries => {
  const head = Buffer.alloc(6 + 16 * entries.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4)
  let offset = head.length
  entries.forEach(({ s, png }, i) => {
    const o = 6 + 16 * i
    head.writeUInt8(s >= 256 ? 0 : s, o); head.writeUInt8(s >= 256 ? 0 : s, o + 1)
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...entries.map(e => e.png)])
}
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs))
fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.find(p => p.s === 256).png)
fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), ico(pngs.filter(p => p.s <= 256)))
fs.copyFileSync(path.join(tmp, 'bare64.png'), path.join(root, 'public', 'mark.png'))
fs.rmSync(tmp, { recursive: true, force: true })
console.log('icons written:', sizes.join(', '))
