// Builds the model list the one-click installer downloads: for every GGUF in %USERPROFILE%\NETRUNNER\models its
// SHA-256 and size (computed here), and where it comes from — Hugging Face at a pinned revision, or this project's
// GitHub release for the models FORGE made (split into parts under GitHub's 2 GiB asset limit).
// Then checks every Hugging Face URL: it must exist and Hugging Face must publish the same SHA-256 and size.
//   node tools/installer/models-manifest.mjs [--release-base <url>] → tools/installer/models.json + models.iss
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MODELS = path.join(process.env.USERPROFILE, 'NETRUNNER', 'models')
const OUT = import.meta.dirname
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const RELEASE = arg('--release-base', 'https://github.com/StanislavTerekhov/NETRUNNER/releases/download/models-v1')
const PART = 1_900_000_000 // < 2 GiB

// Hugging Face sources (repo, revision) by top folder; FORGE outputs go to the GitHub release.
const HF = {
  'Qwen/Qwen3-Coder-Next-GGUF': 'b82fb7382639d97b38fa7672e526c760c2fb358e',
  'Qwen/Qwen3-Embedding-0.6B-GGUF': '370f27d7550e0def9b39c1f16d3fbaa13aa67728',
  'unsloth/Qwen3.8-27B-GGUF': '4ca720788d1e01f1bff70c033e0d0028fd02e502',
  'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF': 'a02f48bb4f057028298c21fa033da2b30d7742d5',
}

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.name === '.cache' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.gguf') ? [path.join(d, e.name)] : [])

const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256')
  fs.createReadStream(file, { highWaterMark: 8 << 20 }).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej)
})

const entries = []
for (const file of walk(MODELS).sort()) {
  const rel = path.relative(MODELS, file).split(path.sep).join('/')
  const size = fs.statSync(file).size
  const sha = await sha256(file)
  const repo = Object.keys(HF).find(r => rel.startsWith(r + '/'))
  if (repo) {
    const inRepo = rel.slice(repo.length + 1)
    entries.push({ rel, size, sha256: sha, source: 'huggingface', url: `https://huggingface.co/${repo}/resolve/${HF[repo]}/${inRepo}` })
  } else {
    const parts = Math.ceil(size / PART)
    const base = rel.replaceAll('/', '__')
    entries.push({ rel, size, sha256: sha, source: 'github', parts: Array.from({ length: parts }, (_, i) => ({ name: parts > 1 ? `${base}.part${i + 1}` : base, url: `${RELEASE}/${parts > 1 ? `${base}.part${i + 1}` : base}` })) })
  }
  console.log(`${(size / 1e9).toFixed(2)} GB  ${sha.slice(0, 12)}  ${rel}`)
}

// Hugging Face publishes an LFS file's SHA-256 as X-Linked-ETag and its size as X-Linked-Size on the resolve URL.
let bad = 0
for (const e of entries.filter(e => e.source === 'huggingface')) {
  const r = await fetch(e.url, { method: 'HEAD', redirect: 'manual' })
  const etag = (r.headers.get('x-linked-etag') ?? '').replaceAll('"', '')
  const size = Number(r.headers.get('x-linked-size'))
  const ok = (r.status === 302 || r.status === 200) && etag === e.sha256 && size === e.size
  if (!ok) bad++
  console.log(`${ok ? 'OK ' : 'BAD'} HF ${r.status} sha ${etag === e.sha256 ? 'match' : etag.slice(0, 12)} size ${size === e.size ? 'match' : size}  ${e.rel}`)
}
fs.writeFileSync(path.join(OUT, 'models.json'), JSON.stringify(entries, null, 2) + '\n')
console.log(`${entries.length} files, ${(entries.reduce((s, e) => s + e.size, 0) / 1e9).toFixed(1)} GB; Hugging Face mismatches: ${bad}`)
if (bad) process.exitCode = 1
