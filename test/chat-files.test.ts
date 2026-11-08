// The chat writes code blocks that name a file into the workspace (NEURAL CORE → FILES: ask / limited / full).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatFileRequest } from '../electron/shared/ipc'
import { checkRequests, undoChatFiles, writeChatFiles, type ChatFileDeps } from '../electron/main/services/chat-files'
import { Workspace } from '../electron/main/services/workspace'
import { extractCodeFiles } from '../src/components/Markdown'
import { cleanPath, codeFilePath, looksPartial } from '../src/lib/code-files'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('code blocks that name a file', () => {
  it('reads the path from the fence or the line above', () => {
    expect(codeFilePath('ts path=src/app.ts', '')).toBe('src/app.ts')
    expect(codeFilePath('python path="tools/run job.py"', '')).toBe('tools/run job.py')
    expect(codeFilePath('ts:src/a.ts', '')).toBe('src/a.ts')
    expect(codeFilePath('ts', '**File:** `src/b.ts`')).toBe('src/b.ts')
    expect(codeFilePath('ts', 'Файл: src/в.ts')).toBe('src/в.ts')
    expect(codeFilePath('ts', 'Here is the code:')).toBeNull()
    expect(codeFilePath('bash', '')).toBeNull()
  })

  it('refuses paths outside the project, into .git, or that are not file names', () => {
    for (const bad of ['../x.ts', '/etc/passwd', 'C:/x.ts', '.git/config', 'src/../../x.ts', 'src/a', 'a|b.ts']) expect(cleanPath(bad)).toBeNull()
    expect(cleanPath('.\\src\\a.ts')).toBe('src/a.ts')
    expect(cleanPath('Dockerfile')).toBe('Dockerfile')
    expect(cleanPath('.env.example')).toBe('.env.example')
  })

  it('flags excerpts so they are never written automatically', () => {
    expect(looksPartial('function a() {}\n// ... existing code ...\n')).toBe(true)
    expect(looksPartial('# rest of the file unchanged\nx = 1')).toBe(true)
    expect(looksPartial('// остальной код без изменений\n')).toBe(true)
    expect(looksPartial('const a = [1, 2, 3]\nconsole.log(...a)\n')).toBe(false)
  })

  it('extracts the last block per path, with a final newline', () => {
    const md = 'One:\n```ts path=src/a.ts\nconst a = 1\n```\nThen:\n```ts path=src/a.ts\nconst a = 2\n```\n```bash\nnpm test\n```\n```py path=b.py\n# ...\n```'
    expect(extractCodeFiles(md)).toEqual([
      { path: 'src/a.ts', content: 'const a = 2\n', partial: false },
      { path: 'b.py', content: '# ...\n', partial: true },
    ])
  })
})

/** In-memory files plus a scripted confirm answer. */
function fakeDeps(files: Record<string, string>, answer: boolean) {
  const asked: string[][] = []
  const deps: ChatFileDeps = {
    read: async p => files[p] ?? null,
    put: async (p, content) => {
      const previous = files[p] ?? null
      files[p] = content
      return { path: p, previous }
    },
    remove: async p => void delete files[p],
    confirm: async lines => (asked.push(lines), answer),
  }
  return { deps, asked, files }
}

const req = (p: string, content: string, partial = false): ChatFileRequest => ({ path: p, content, partial })

describe('write modes', () => {
  const answer = [req('new.ts', 'n\n'), req('old.ts', 'v2\n'), req('same.ts', 's\n'), req('cut.ts', '// ...\n', true)]
  const disk = () => ({ 'old.ts': 'v1\n', 'same.ts': 's\n', 'cut.ts': 'full\n' })

  it('ask: nothing after the answer; SAVE asks once for everything', async () => {
    const auto = fakeDeps(disk(), true)
    const r = await writeChatFiles(auto.deps, answer, 'auto', 'ask')
    expect(r.map(x => x.status)).toEqual(['pending', 'pending', 'unchanged', 'pending'])
    expect(auto.asked).toHaveLength(0)
    const manual = fakeDeps(disk(), true)
    const m = await writeChatFiles(manual.deps, answer, 'manual', 'ask')
    expect(m.map(x => x.status)).toEqual(['created', 'overwritten', 'unchanged', 'overwritten'])
    expect(manual.asked[0]).toEqual(['+ new.ts (1)', '~ old.ts (1 → 1)', '~ cut.ts (1 → 1)'])
  })

  it('limited: new files at once, overwrites wait; declined SAVE writes nothing', async () => {
    const { deps, files } = fakeDeps(disk(), false)
    const r = await writeChatFiles(deps, answer, 'auto', 'limited')
    expect(r.map(x => x.status)).toEqual(['created', 'pending', 'unchanged', 'pending'])
    expect(files['new.ts']).toBe('n\n')
    const m = await writeChatFiles(deps, [req('old.ts', 'v2\n')], 'manual', 'limited')
    expect(m[0].status).toBe('pending')
    expect(files['old.ts']).toBe('v1\n')
  })

  it('full: everything that is a whole file at once; an excerpt over a file is still asked', async () => {
    const { deps, asked, files } = fakeDeps(disk(), false)
    const r = await writeChatFiles(deps, answer, 'auto', 'full')
    expect(r.map(x => x.status)).toEqual(['created', 'overwritten', 'unchanged', 'pending'])
    expect(files['old.ts']).toBe('v2\n')
    await writeChatFiles(deps, [req('cut.ts', '// ...\n', true)], 'manual', 'full')
    expect(asked).toHaveLength(1)
    expect(files['cut.ts']).toBe('full\n')
  })

  it('undo puts the old content back and removes created files', async () => {
    const { deps, files } = fakeDeps(disk(), true)
    const r = await writeChatFiles(deps, answer.slice(0, 2), 'auto', 'full')
    const u = await undoChatFiles(deps, r.map((x, i) => ({ path: x.path, previous: x.previous, expected: answer[i].content })))
    expect(u.map(x => x.status)).toEqual(['undone', 'undone'])
    expect(files['new.ts']).toBeUndefined()
    expect(files['old.ts']).toBe('v1\n')
  })

  it('undo refuses when the file changed after the write (a later answer or an edit)', async () => {
    const { deps, files } = fakeDeps({}, true)
    const first = await writeChatFiles(deps, [req('a.py', 'v1\n')], 'auto', 'full')
    await writeChatFiles(deps, [req('a.py', 'v2\n')], 'auto', 'full')
    const u = await undoChatFiles(deps, [{ path: 'a.py', previous: first[0].previous, expected: 'v1\n' }])
    expect(u[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/changed after this write/) })
    expect(files['a.py']).toBe('v2\n')
  })

  it('checks the renderer input', () => {
    expect(() => checkRequests([])).toThrow()
    expect(() => checkRequests([{ path: 'a.ts' }])).toThrow(/Malformed/)
    expect(() => checkRequests(Array.from({ length: 21 }, () => req('a.ts', '')))).toThrow()
  })
})

describe('Workspace.put', () => {
  it('creates folders, returns the previous content and stays inside the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-put-'))
    temps.push(root)
    const ws = new Workspace()
    await ws.open(root)
    expect(await ws.put('src/deep/a.ts', 'one\n')).toEqual({ path: 'src/deep/a.ts', previous: null })
    expect(await ws.put('src/deep/a.ts', 'two\n')).toEqual({ path: 'src/deep/a.ts', previous: 'one\n' })
    expect(fs.readFileSync(path.join(root, 'src/deep/a.ts'), 'utf8')).toBe('two\n')
    await expect(ws.put('../escape.ts', 'x')).rejects.toThrow()
    await expect(ws.put('.git/config', 'x')).rejects.toThrow(/Git internals|Invalid/)
    await expect(ws.put('src/con.ts', 'x')).rejects.toThrow(/Reserved/)
    await expect(ws.put('src', 'x')).rejects.toThrow(/Not a file/)
  })
})
