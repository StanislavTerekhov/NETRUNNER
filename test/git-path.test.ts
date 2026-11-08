import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathWithGit } from '../electron/main/services/git-path'

describe('Git on PATH after a fresh install', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nr-git-'))
  it('appends the per-user Git folder when git is not on PATH', () => {
    const local = tmp(), other = tmp()
    fs.mkdirSync(path.join(local, 'Programs', 'Git', 'cmd'), { recursive: true })
    fs.writeFileSync(path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'), '')
    expect(pathWithGit(other, { LOCALAPPDATA: local })).toBe([other, path.join(local, 'Programs', 'Git', 'cmd')].join(path.delimiter))
  })
  it('leaves PATH alone when git is already on it or nowhere to be found', () => {
    const has = tmp(), local = tmp()
    fs.writeFileSync(path.join(has, 'git.exe'), '')
    expect(pathWithGit(has, { LOCALAPPDATA: local })).toBe(has)
    expect(pathWithGit(local, { LOCALAPPDATA: local })).toBe(local)
  })
})
