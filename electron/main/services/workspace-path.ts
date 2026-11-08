import path from 'node:path'

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceAccessError'
  }
}

/**
 * Resolve a renderer-supplied relative path against the workspace root and refuse anything
 * that escapes it (.., absolute paths, other drives, UNC paths, NUL bytes).
 * Pure function so it can be unit-tested on any platform via the `impl` argument.
 */
export function resolveInWorkspace(
  root: string,
  relPath: string,
  impl: path.PlatformPath = path,
): string {
  if (typeof relPath !== 'string') throw new WorkspaceAccessError('Path must be a string')
  if (relPath.includes('\0')) throw new WorkspaceAccessError('Path contains a NUL byte')
  if (impl.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\') || relPath.startsWith('//')) {
    throw new WorkspaceAccessError('Absolute paths are not allowed')
  }

  const normalizedRoot = impl.resolve(root)
  const target = impl.resolve(normalizedRoot, relPath)
  const rel = impl.relative(normalizedRoot, target)

  if (rel === '') return normalizedRoot
  if (rel.startsWith('..') || impl.isAbsolute(rel)) {
    throw new WorkspaceAccessError(`Path escapes the workspace: ${relPath}`)
  }
  return target
}

/** Convert an absolute path inside the workspace to the forward-slash relative form the renderer uses. */
export function toWorkspaceRelative(root: string, absPath: string, impl: path.PlatformPath = path): string {
  return impl.relative(impl.resolve(root), absPath).split(impl.sep).join('/')
}
