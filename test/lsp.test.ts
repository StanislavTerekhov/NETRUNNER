// LspService against the real bundled pyright (run with this Node over stdio; the app runs it in an Electron
// utility process). Checks diagnostics, hover, completion and go-to-definition on a small Python file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { frame, LspFramer, LspService, stdioTransport } from '../electron/main/services/lsp'

const pyright = path.resolve(import.meta.dirname, '..', 'node_modules', 'pyright', 'langserver.index.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-lsp-'))
const diagnostics = new Map<string, { message: string; range: { start: { line: number } } }[]>()
const lsp = new LspService(
  [{ id: 'python', label: 'pyright', languages: ['python'], launch: r => Promise.resolve(stdioTransport(process.execPath, [pyright, '--stdio'], r)) }],
  () => root,
  (p, d) => diagnostics.set(p, d as never),
)
afterAll(async () => {
  await lsp.stopAll()
  await new Promise(r => setTimeout(r, 800))
  fs.rmSync(root, { recursive: true, force: true })
})

const SOURCE = ['def add(a: int, b: int) -> int:', '    """Add two numbers."""', '    return a + b', '', 'x = add(1, 2)', 'y: str = add(1, 2)', 'x.'].join('\n')

describe('LSP framing', () => {
  it('splits Content-Length frames across arbitrary chunks', () => {
    const msgs: unknown[] = []
    const f = new LspFramer()
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: 'ü' })])
    for (let i = 0; i < bytes.length; i += 7) f.push(bytes.subarray(i, i + 7), m => msgs.push(m))
    expect(msgs).toEqual([{ a: 1 }, { b: 'ü' }])
  })
})

describe('LspService with pyright', () => {
  it(
    'reports type errors, hovers, completes and finds definitions',
    async () => {
      fs.writeFileSync(path.join(root, 'calc.py'), SOURCE)
      expect(await lsp.open('calc.py', 'python', SOURCE)).toBe(true)
      expect(await lsp.open('notes.txt', 'plaintext', 'hi')).toBe(false)

      const deadline = Date.now() + 60000
      while (Date.now() < deadline && !(diagnostics.get('calc.py') ?? []).some(d => d.range.start.line === 5)) await new Promise(r => setTimeout(r, 200))
      const diag = diagnostics.get('calc.py') ?? []
      console.log(`[lsp] diagnostics: ${JSON.stringify(diag.map(d => `${d.range.start.line}: ${d.message.split('\n')[0]}`))}`)
      expect(diag.some(d => d.range.start.line === 5 && /int/.test(d.message) && /str/.test(d.message))).toBe(true)

      const hover = (await lsp.request('calc.py', 'hover', { line: 4, character: 5 })) as { contents: { value: string } }
      console.log(`[lsp] hover: ${JSON.stringify(hover.contents.value)}`)
      expect(hover.contents.value.replace(/\s+/g, ' ')).toMatch(/def add\( a: int, b: int \) -> int/)
      expect(hover.contents.value).toContain('Add two numbers.')

      const completion = (await lsp.request('calc.py', 'completion', { line: 6, character: 2 })) as { items: { label: string }[] }
      const labels = completion.items.map(i => i.label)
      console.log(`[lsp] completion after "x.": ${labels.length} items, e.g. ${labels.slice(0, 5).join(', ')}`)
      expect(labels).toContain('bit_length')

      const def = (await lsp.request('calc.py', 'definition', { line: 4, character: 5 })) as { path: string; range: { start: { line: number } } }[]
      expect(def[0]).toMatchObject({ path: 'calc.py', range: { start: { line: 0 } } })

      // An edit is seen: fixing the annotation clears the error.
      await lsp.change('calc.py', SOURCE.replace('y: str', 'y: int'))
      const fixedBy = Date.now() + 30000
      while (Date.now() < fixedBy && (diagnostics.get('calc.py') ?? []).some(d => d.range.start.line === 5)) await new Promise(r => setTimeout(r, 200))
      expect((diagnostics.get('calc.py') ?? []).some(d => d.range.start.line === 5)).toBe(false)
      expect(lsp.status().find(s => s.id === 'python')?.state).toBe('running')
    },
    120000,
  )
})
