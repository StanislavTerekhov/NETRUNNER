import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInWorkspace, toWorkspaceRelative, WorkspaceAccessError } from '../electron/main/services/workspace-path'

describe('resolveInWorkspace (win32)', () => {
  const root = 'C:\\proj'
  const r = (p: string) => resolveInWorkspace(root, p, path.win32)

  it('resolves paths inside the root', () => {
    expect(r('')).toBe('C:\\proj')
    expect(r('src/index.ts')).toBe('C:\\proj\\src\\index.ts')
    expect(r('src\\a\\..\\b.ts')).toBe('C:\\proj\\src\\b.ts')
  })

  it.each([
    '..',
    '../secret.txt',
    'src/../../etc',
    '..\\..\\Windows\\System32',
    'C:\\Windows\\win.ini',
    'D:relative',
    'c:/proj/../other',
    '\\\\server\\share\\x',
    '//server/share/x',
    '\\Windows',
    'a\0b',
  ])('rejects %j', p => {
    expect(() => r(p)).toThrow(WorkspaceAccessError)
  })

  it('does not treat a sibling with a common prefix as inside', () => {
    expect(() => r('../proj-evil/x')).toThrow(WorkspaceAccessError)
  })
})

describe('resolveInWorkspace (posix)', () => {
  const r = (p: string) => resolveInWorkspace('/home/u/proj', p, path.posix)
  it('resolves and rejects', () => {
    expect(r('a/b')).toBe('/home/u/proj/a/b')
    expect(() => r('/etc/passwd')).toThrow(WorkspaceAccessError)
    expect(() => r('a/../../x')).toThrow(WorkspaceAccessError)
  })
})

describe('toWorkspaceRelative', () => {
  it('uses forward slashes', () => {
    expect(toWorkspaceRelative('C:\\proj', 'C:\\proj\\src\\a.ts', path.win32)).toBe('src/a.ts')
  })
})
