import { watch as watchFs, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DirEntry, FileContent, WorkspaceInfo } from '../../shared/ipc'
import { resolveInWorkspace, toWorkspaceRelative, WorkspaceAccessError } from './workspace-path'

/** Files larger than this are refused by the editor to keep the renderer responsive. */
export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024

/** A single file or folder name: no separators, no Windows-reserved characters or device names. */
export function validName(name: string): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n === '.' || n === '..' || n.length > 255) throw new WorkspaceAccessError('Invalid name')
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n) || /[. ]$/.test(n)) throw new WorkspaceAccessError(`Invalid characters in name: ${n}`)
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) throw new WorkspaceAccessError(`Reserved name: ${n}`)
  return n
}

/** Changes under these top-level folders are not reported (dependency installs and git internals churn constantly). */
const WATCH_IGNORE = /^(\.git|node_modules)(\/|$)/

/** Owns the currently open workspace root. All renderer file access goes through here. */
export class Workspace {
  private root: string | null = null
  private watcher: FSWatcher | null = null

  /** `trash` moves a path to the OS recycle bin (Electron's shell.trashItem); deletion is never permanent. */
  constructor(
    private readonly trash: (abs: string) => Promise<void> = p => fs.rm(p, { recursive: true }),
    private readonly onChange: (paths: string[]) => void = () => undefined,
  ) {}

  get current(): WorkspaceInfo | null {
    return this.root ? { root: this.root, name: path.basename(this.root) } : null
  }

  async open(root: string): Promise<WorkspaceInfo> {
    const abs = path.resolve(root)
    const stat = await fs.stat(abs)
    if (!stat.isDirectory()) throw new WorkspaceAccessError(`Not a directory: ${abs}`)
    this.root = abs
    this.watch(abs)
    return this.current!
  }

  /** Report changes made on disk (agents, git, other editors) as workspace-relative paths, batched. */
  private watch(abs: string): void {
    this.watcher?.close()
    this.watcher = null
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | null = null
    try {
      this.watcher = watchFs(abs, { recursive: true }, (_event, file) => {
        if (!file || this.root !== abs) return
        const rel = file.toString().split(path.sep).join('/')
        if (WATCH_IGNORE.test(rel)) return
        pending.add(rel)
        timer ??= setTimeout(() => {
          timer = null
          const paths = [...pending]
          pending.clear()
          if (this.root === abs) this.onChange(paths)
        }, 250)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      /* watching is a convenience: the explorer's refresh still works */
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /** Create an empty file or a folder at `relPath` (parent folders must exist). */
  async create(relPath: string, kind: 'file' | 'dir'): Promise<DirEntry> {
    const root = this.requireRoot()
    validName(path.posix.basename(relPath))
    const target = await this.resolve(relPath)
    if (await fs.stat(target).catch(() => null)) throw new WorkspaceAccessError(`Already exists: ${relPath}`)
    if (kind === 'dir') await fs.mkdir(target)
    else await fs.writeFile(target, '', { flag: 'wx' })
    return { name: path.basename(target), path: toWorkspaceRelative(root, target), kind }
  }

  /**
   * Write a whole text file for the chat: missing folders are created, every path segment is a valid name and git
   * internals are off limits. Returns the content before the write (null when the file is new) for undo.
   */
  async put(relPath: string, content: string): Promise<{ path: string; previous: string | null }> {
    const root = this.requireRoot()
    const parts = String(relPath).replace(/\\/g, '/').split('/')
    for (const p of parts) validName(p)
    if (parts.some(p => p.toLowerCase() === '.git')) throw new WorkspaceAccessError('Git internals cannot be written')
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new WorkspaceAccessError(`Content must be text of at most ${MAX_EDITABLE_BYTES} bytes`)
    }
    const file = await this.resolve(parts.join('/'))
    const stat = await fs.stat(file).catch(() => null)
    if (stat && !stat.isFile()) throw new WorkspaceAccessError(`Not a file: ${relPath}`)
    const previous = stat ? (await this.read(parts.join('/'))).content : null
    await fs.mkdir(path.dirname(file), { recursive: true })
    // The folders just created are inside the workspace; check again before writing through them.
    await this.resolve(parts.join('/'))
    await this.write(parts.join('/'), content, null)
    return { path: toWorkspaceRelative(root, file), previous }
  }

  /** Rename (or move inside the workspace); refuses to overwrite. */
  async rename(fromRel: string, toRel: string): Promise<string> {
    const root = this.requireRoot()
    validName(path.posix.basename(toRel))
    const from = await this.resolve(fromRel)
    const to = await this.resolve(toRel)
    if (from === path.resolve(root)) throw new WorkspaceAccessError('The workspace root cannot be renamed')
    // A case-only rename on Windows points at the same file; anything else must not exist yet.
    if (from.toLowerCase() !== to.toLowerCase() && (await fs.stat(to).catch(() => null))) throw new WorkspaceAccessError(`Already exists: ${toRel}`)
    await fs.rename(from, to)
    return toWorkspaceRelative(root, to)
  }

  /** Move a file or folder to the recycle bin. */
  async remove(relPath: string): Promise<void> {
    const root = this.requireRoot()
    const target = await this.resolve(relPath)
    if (target === path.resolve(root)) throw new WorkspaceAccessError('The workspace root cannot be deleted')
    await fs.stat(target)
    await this.trash(target)
  }

  private requireRoot(): string {
    if (!this.root) throw new WorkspaceAccessError('No workspace is open')
    return this.root
  }

  /**
   * Lexical check plus a realpath check, so a symlink or junction inside the workspace
   * cannot be used to reach files outside it. For paths that do not exist yet, the parent is checked.
   */
  private async resolve(relPath: string): Promise<string> {
    const root = this.requireRoot()
    const target = resolveInWorkspace(root, relPath)
    const realRoot = await fs.realpath(root)
    let probe = target
    let real: string | null = null
    while (real === null) {
      real = await fs.realpath(probe).catch(() => null)
      if (real === null) {
        const parent = path.dirname(probe)
        if (parent === probe) throw new WorkspaceAccessError(`Cannot resolve ${relPath}`)
        probe = parent
      }
    }
    const rel = path.relative(realRoot, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorkspaceAccessError(`Path resolves outside the workspace: ${relPath}`)
    }
    return target
  }

  async list(relPath: string): Promise<DirEntry[]> {
    const root = this.requireRoot()
    const dir = await this.resolve(relPath)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const listed = await Promise.all(
      entries.map(async (e): Promise<DirEntry | null> => {
        let kind: DirEntry['kind'] | null = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : null
        if (e.isSymbolicLink()) {
          // Links are listed by target type; opening them still goes through the realpath check.
          const stat = await fs.stat(path.join(dir, e.name)).catch(() => null)
          kind = stat?.isDirectory() ? 'dir' : stat?.isFile() ? 'file' : null
        }
        return kind ? { name: e.name, path: toWorkspaceRelative(root, path.join(dir, e.name)), kind } : null
      }),
    )
    return listed
      .filter((e): e is DirEntry => e !== null)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  }

  async read(relPath: string): Promise<FileContent> {
    const root = this.requireRoot()
    const file = await this.resolve(relPath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new WorkspaceAccessError(`Not a file: ${relPath}`)
    if (stat.size > MAX_EDITABLE_BYTES) {
      throw new WorkspaceAccessError(`File is too large to edit (${stat.size} bytes)`)
    }
    const buf = await fs.readFile(file)
    if (buf.subarray(0, 8000).includes(0)) throw new WorkspaceAccessError('Binary files cannot be opened in the editor')
    return { path: toWorkspaceRelative(root, file), content: buf.toString('utf8'), size: stat.size, mtimeMs: stat.mtimeMs }
  }

  /**
   * Write a text file. When expectedMtimeMs is given and the file changed on disk since it was read,
   * the write is refused so an external edit is never silently overwritten.
   */
  async write(relPath: string, content: string, expectedMtimeMs: number | null): Promise<FileContent> {
    const root = this.requireRoot()
    const file = await this.resolve(relPath)
    if (typeof content !== 'string') throw new WorkspaceAccessError('Content must be a string')
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new WorkspaceAccessError(`File is too large to save from the editor (limit ${MAX_EDITABLE_BYTES} bytes)`)
    }
    if (expectedMtimeMs !== null) {
      const stat = await fs.stat(file).catch(() => null)
      if (stat && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
        throw new WorkspaceAccessError('File changed on disk since it was opened; reload it before saving')
      }
    }
    const tmp = `${file}.netrunner-${process.pid}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, file)
    const stat = await fs.stat(file)
    return { path: toWorkspaceRelative(root, file), content, size: stat.size, mtimeMs: stat.mtimeMs }
  }
}
