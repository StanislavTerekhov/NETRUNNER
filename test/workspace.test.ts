import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Workspace } from '../electron/main/services/workspace'
import { SettingsStore } from '../electron/main/services/settings'
import { languageForPath } from '../src/lib/languages'

let tmp: string
let root: string
let outside: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-test-'))
  root = path.join(tmp, 'proj')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'README.md'), '# hi\n')
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  // A junction inside the workspace pointing outside of it (works without admin rights on Windows).
  await fs.symlink(outside, path.join(root, 'escape'), 'junction')
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('Workspace', () => {
  it('refuses access before a workspace is opened', async () => {
    await expect(new Workspace().list('')).rejects.toThrow(/No workspace/)
  })

  it('lists directories first, then files', async () => {
    const ws = new Workspace()
    await ws.open(root)
    const entries = await ws.list('')
    expect(entries.map(e => `${e.kind}:${e.path}`)).toEqual(['dir:escape', 'dir:src', 'file:bin.dat', 'file:README.md'])
  })

  it('reads and writes text files', async () => {
    const ws = new Workspace()
    await ws.open(root)
    const file = await ws.read('src/a.ts')
    expect(file.content).toBe('export const a = 1\n')
    const written = await ws.write('src/a.ts', 'export const a = 2\n', file.mtimeMs)
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(written.mtimeMs).toBeGreaterThan(0)
  })

  it('refuses to overwrite a file changed on disk since it was read', async () => {
    const ws = new Workspace()
    await ws.open(root)
    const file = await ws.read('README.md')
    const later = new Date(Date.now() + 10_000)
    await fs.utimes(path.join(root, 'README.md'), later, later)
    await expect(ws.write('README.md', 'clobber', file.mtimeMs)).rejects.toThrow(/changed on disk/)
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# hi\n')
  })

  it('refuses to write content above the editor size limit', async () => {
    const ws = new Workspace()
    await ws.open(root)
    await expect(ws.write('big.txt', 'x'.repeat(5 * 1024 * 1024 + 1), null)).rejects.toThrow(/too large/)
    await expect(fs.access(path.join(root, 'big.txt'))).rejects.toThrow()
  })

  it('refuses binary files', async () => {
    const ws = new Workspace()
    await ws.open(root)
    await expect(ws.read('bin.dat')).rejects.toThrow(/Binary/)
  })

  it('blocks traversal and junction escapes', async () => {
    const ws = new Workspace()
    await ws.open(root)
    await expect(ws.read('../outside/secret.txt')).rejects.toThrow(/escapes/)
    await expect(ws.read('escape/secret.txt')).rejects.toThrow(/outside the workspace/)
    await expect(ws.list('escape')).rejects.toThrow(/outside the workspace/)
    await expect(ws.write('escape/new.txt', 'x', null)).rejects.toThrow(/outside the workspace/)
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow()
  })
})

describe('SettingsStore', () => {
  it('persists recent workspaces, most recent first, without duplicates', async () => {
    const dir = path.join(tmp, 'userdata')
    const a = new SettingsStore(dir)
    await a.load()
    await a.rememberWorkspace('C:\\one')
    await a.rememberWorkspace('C:\\two')
    await a.rememberWorkspace('C:\\one')
    const b = new SettingsStore(dir)
    const loaded = await b.load()
    expect(loaded.recentWorkspaces).toEqual(['C:\\one', 'C:\\two'])
    expect(loaded.lastWorkspace).toBe('C:\\one')
  })

  it('reads settings written with a UTF-8 BOM', async () => {
    const dir = path.join(tmp, 'bom')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'settings.json'), '\uFEFF{"recentWorkspaces":["C:\\\\x"],"lastWorkspace":"C:\\\\x"}')
    expect(await new SettingsStore(dir).load()).toMatchObject({ recentWorkspaces: ['C:\\x'], lastWorkspace: 'C:\\x' })
  })

  it('falls back to defaults on a corrupt file', async () => {
    const dir = path.join(tmp, 'corrupt')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'settings.json'), '{not json')
    expect(await new SettingsStore(dir).load()).toMatchObject({ recentWorkspaces: [], lastWorkspace: null, networkMode: 'strict-offline' })
  })
})

describe('languageForPath', () => {
  it('maps common extensions', () => {
    expect(languageForPath('src/App.tsx')).toBe('typescript')
    expect(languageForPath('a/b/script.PS1')).toBe('powershell')
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('LICENSE')).toBe('plaintext')
  })
})
