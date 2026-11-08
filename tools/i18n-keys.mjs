// Lists the English source strings passed to t()/tr() in src (first argument, string literal), for the RU
// dictionary. `node tools/i18n-keys.mjs --missing` prints only keys without a Russian entry.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function extractKeys(dir = path.join(root, 'src')) {
  const keys = new Set()
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.startsWith('i18n')) {
        const src = fs.readFileSync(p, 'utf8')
        for (const m of src.matchAll(/\b(?:t|tr)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) keys.add(m[2].replace(/\\(['"\\])/g, '$1'))
      }
    }
  }
  walk(dir)
  return [...keys].sort()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const keys = extractKeys()
  if (process.argv.includes('--missing')) {
    const dict = fs.readFileSync(path.join(root, 'src', 'lib', 'i18n-ru.ts'), 'utf8')
    for (const k of keys) if (!dict.includes(JSON.stringify(k))) console.log(k)
  } else for (const k of keys) console.log(k)
}
