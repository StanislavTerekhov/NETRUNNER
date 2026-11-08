import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper without types
import { extractKeys } from '../tools/i18n-keys.mjs'
import { RU } from '../src/lib/i18n-ru'

// The renderer modules need the preload API, so their labels are read from the source text.
const src = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', f), 'utf8')
const SECTIONS = [...src('app/sections.ts').matchAll(/label: '([^']+)'.*?summary: '([^']+)'/g)].map(m => ({ label: m[1], summary: m[2] }))
const BUILTIN_LAYOUTS = [...src('app/layout-store.ts').matchAll(/\{ id: '[\w-]+', name: '([^']+)'/g)].map(m => ({ name: m[1] }))

/** translate() without the store (src/lib/i18n.ts needs the preload API). */
const tr = (text: string, vars: Record<string, string | number> = {}) => {
  let out = RU[text] ?? text
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

describe('Russian interface', () => {
  it('has a translation for every t() literal in src', () => {
    const keys = extractKeys() as string[]
    expect(keys.length).toBeGreaterThan(300)
    expect(keys.filter(k => !(k in RU))).toEqual([])
  })

  it('covers the dynamic labels: sections, layouts, task and job states, roles', () => {
    expect(SECTIONS.length).toBe(11)
    expect(BUILTIN_LAYOUTS.length).toBe(5)
    const dynamic = [
      ...SECTIONS.flatMap(s => [s.label, s.summary]),
      ...BUILTIN_LAYOUTS.map(l => l.name),
      ...['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted', 'active', 'ready', 'merged', 'discarded'],
      ...['ARCHITECT', 'CODER', 'DEBUGGER', 'REVIEWER', 'OPERATOR'],
      ...['OWN SECTION', 'BELOW EDITOR', 'RIGHT SIDE', 'term bottom', 'term right'],
    ]
    expect(dynamic.filter(k => !(k in RU))).toEqual([])
  })

  it('keeps placeholders when translating', () => {
    for (const [en, ru] of Object.entries(RU)) {
      const want = [...en.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      const got = [...ru.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      expect({ en, placeholders: got }).toEqual({ en, placeholders: want })
    }
    expect(tr('{n} file(s) changed', { n: 3 })).toBe('изменено файлов: 3')
  })
})
