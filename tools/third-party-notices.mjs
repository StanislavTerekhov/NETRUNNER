// Generates build/THIRD_PARTY_NOTICES.txt from the license files actually present in node_modules.
// Covered: production dependencies (and their dependencies), packages bundled into the renderer by Vite,
// and the OpenCode binary shipped as an extra resource. Electron's own and Chromium's licenses are
// added to the install folder by electron-builder (LICENSE.electron.txt, LICENSES.chromium.html).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nm = path.join(root, 'node_modules')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// Bundled into dist/ by Vite (they are devDependencies only because the build inlines them).
const RENDERER_BUNDLED = [
  'react', 'react-dom', 'scheduler', 'monaco-editor', '@monaco-editor/react', '@monaco-editor/loader', 'state-local', 'dompurify', 'marked',
  '@xterm/xterm', '@xterm/addon-fit', 'zustand', 'use-sync-external-store', 'motion', 'framer-motion', 'motion-dom', 'motion-utils',
  'lucide-react', 'react-resizable-panels',
]
const EXTRA = ['opencode-ai', 'sqlite-vec-windows-x64']

const readPkg = name => {
  const p = path.join(nm, ...name.split('/'), 'package.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

// Walk production dependencies transitively.
const seen = new Map()
// Only the x64 OpenCode binary is shipped (electron-builder.json extraResources); other platform builds are not.
const NOT_SHIPPED = /^opencode-(?!windows-x64$)/
const visit = name => {
  if (seen.has(name) || NOT_SHIPPED.test(name)) return
  const p = readPkg(name)
  if (!p) return
  seen.set(name, p)
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) visit(dep)
}
for (const name of [...Object.keys(pkg.dependencies ?? {}), ...RENDERER_BUNDLED, ...EXTRA]) visit(name)

// Packages whose license file lives in a sibling package of the same project.
const LICENSE_FROM = { 'opencode-windows-x64': 'opencode-ai', '@opencode-ai/sdk': 'opencode-ai', 'sqlite-vec-windows-x64': 'sqlite-vec' }
const licenseText = name => {
  const dir = path.join(nm, ...(LICENSE_FROM[name] ?? name).split('/'))
  const file = fs.readdirSync(dir).find(f => /^(licen[cs]e|copying|unlicense)(\.|-|$)/i.test(f))
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null
}

const entries = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))
const missing = []
let out = `NETRUNNER ${pkg.version} — third-party software notices\n`
out += `Generated ${new Date().toISOString().slice(0, 10)} from node_modules. ${entries.length} packages.\n`
out += `Electron and Chromium notices: see LICENSE.electron.txt and LICENSES.chromium.html in the installation folder.\n`
out += `Local models (Qwen, served by Ollama) are not part of this installer; their licenses are shown in the Model Vault.\n`
for (const [name, p] of entries) {
  const text = licenseText(name)
  if (!text) missing.push(`${name}@${p.version} (${p.license ?? 'unknown'})`)
  const license = p.license ?? (LICENSE_FROM[name] ? readPkg(LICENSE_FROM[name])?.license : undefined) ?? 'unknown'
  out += `\n${'='.repeat(78)}\n${name} ${p.version}\nLicense: ${typeof license === 'string' ? license : JSON.stringify(license)}\n`
  if (p.homepage || p.repository) out += `Source: ${p.homepage ?? (typeof p.repository === 'string' ? p.repository : p.repository?.url)}\n`
  out += `${'-'.repeat(78)}\n${text ?? '(no license file in the package; see the License field above)'}\n`
}
fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.writeFileSync(path.join(root, 'build', 'THIRD_PARTY_NOTICES.txt'), out)
console.log(`THIRD_PARTY_NOTICES.txt: ${entries.length} packages, ${missing.length} without a license file`)
if (missing.length) console.log(`  without file: ${missing.join(', ')}`)
const licenses = {}
for (const [name, p] of entries) {
  const l = p.license ?? (LICENSE_FROM[name] ? readPkg(LICENSE_FROM[name])?.license : undefined) ?? 'unknown'
  licenses[l] = (licenses[l] ?? 0) + 1
}
console.log(`  licenses: ${JSON.stringify(licenses)}`)
