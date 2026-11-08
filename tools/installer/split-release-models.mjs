// Cuts the models that are not on Hugging Face (FORGE outputs) into parts under GitHub's 2 GiB release-asset limit,
// writes them to <out> for upload and records each part's SHA-256 and size in models.json.
//   node tools/installer/split-release-models.mjs <out-dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: split-release-models.mjs <out-dir>')
fs.mkdirSync(out, { recursive: true })
const manifest = path.join(import.meta.dirname, 'models.json')
const entries = JSON.parse(fs.readFileSync(manifest, 'utf8'))
const MODELS = path.join(process.env.USERPROFILE, 'NETRUNNER', 'models')
const PART = 1_900_000_000
const CHUNK = 8 << 20

for (const e of entries.filter(e => e.source === 'github')) {
  const fd = fs.openSync(path.join(MODELS, e.rel), 'r')
  const buf = Buffer.alloc(CHUNK)
  let pos = 0
  for (const p of e.parts) {
    const target = path.join(out, p.name)
    const w = fs.openSync(target, 'w')
    const h = crypto.createHash('sha256')
    let left = Math.min(PART, e.size - pos)
    p.size = left
    while (left > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, left), pos)
      fs.writeSync(w, buf, 0, n)
      h.update(buf.subarray(0, n))
      pos += n
      left -= n
    }
    fs.closeSync(w)
    p.sha256 = h.digest('hex')
    console.log(`${(p.size / 1e9).toFixed(2)} GB  ${p.sha256.slice(0, 12)}  ${p.name}`)
  }
  fs.closeSync(fd)
  if (pos !== e.size) throw new Error(`${e.rel}: wrote ${pos} of ${e.size}`)
}
fs.writeFileSync(manifest, JSON.stringify(entries, null, 2) + '\n')
