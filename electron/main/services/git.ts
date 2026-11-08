import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChangedFile, Checkpoint, FileVersions, GitStatus } from '../../shared/ipc'
import { resolveInWorkspace } from './workspace-path'

const REF_PREFIX = 'refs/netrunner/checkpoints/'

interface RunOpts {
  env?: Record<string, string>
  maxBuffer?: number
  /** Run in another directory (a worktree) instead of the workspace root. */
  cwd?: string
}

/** Result of bringing a worktree's changes into the workspace. */
export interface MergeResult {
  applied: string[]
  /** Files changed on both sides that could not be merged cleanly (text files get conflict markers). */
  conflicts: string[]
}

/**
 * Git operations for a workspace. Checkpoints snapshot the working tree (tracked + untracked, honouring
 * .gitignore) into commits under refs/netrunner/checkpoints/ using a temporary index, so the user's
 * index, HEAD and branches are never modified.
 */
export class GitService {
  constructor(private readonly getRoot: () => string | null) {}

  private root(): string {
    const r = this.getRoot()
    if (!r) throw new Error('No workspace is open')
    return r
  }

  private run(args: string[], opts: RunOpts = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args],
        { cwd: opts.cwd ?? this.root(), env: { ...process.env, ...opts.env }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
      )
    })
  }

  /** Blob content as bytes (binary-safe), or null when the path does not exist in that commit. */
  private blob(commit: string, relPath: string): Promise<Buffer | null> {
    return new Promise(resolve => {
      execFile(
        'git',
        ['cat-file', 'blob', `${commit}:${relPath}`],
        { cwd: this.root(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout),
      )
    })
  }

  async isRepo(): Promise<boolean> {
    try {
      // Must be the top level: a workspace nested inside another repo is not treated as a repo of its own.
      const top = (await this.run(['rev-parse', '--show-toplevel'])).trim()
      return path.resolve(top).toLowerCase() === path.resolve(this.root()).toLowerCase()
    } catch {
      return false
    }
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo())) return { isRepo: false, branch: null, head: null, files: [] }
    const branch = (await this.run(['branch', '--show-current']).catch(() => '')).trim() || null
    const head = (await this.run(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null
    const raw = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const files = []
    const parts = raw.split('\0').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2)
      files.push({ path: parts[i].slice(3), code })
      if (code[0] === 'R' || code[0] === 'C') i++ // rename source follows
    }
    return { isRepo: true, branch, head, files }
  }

  async init(): Promise<GitStatus> {
    if (!(await this.isRepo())) await this.run(['init'])
    return this.status()
  }

  /** Write the working tree (minus ignored files) of the workspace or a worktree as a tree object, via a throwaway index. */
  private async snapshotTree(cwd?: string): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-idx-'))
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
    try {
      await this.run(['add', '-A', '--', '.'], { env, cwd })
      return (await this.run(['write-tree'], { env, cwd })).trim()
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }

  private async diffTrees(a: string, b: string): Promise<ChangedFile[]> {
    const out = await this.run(['diff-tree', '-r', '--no-renames', '--name-status', '-z', a, b])
    const parts = out.split('\0').filter(Boolean)
    const files: ChangedFile[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] as ChangedFile['status']
      if (status === 'A' || status === 'M' || status === 'D') files.push({ status, path: parts[i + 1] })
    }
    return files
  }

  // ------------------------------------------------------------------------------------------
  // Worktrees for agents working in parallel: each job edits its own checkout of a checkpoint,
  // and its changes reach the workspace only through mergeWorktree (after the operator asks).
  // ------------------------------------------------------------------------------------------

  /**
   * Check out `commit` (a checkpoint of the workspace, uncommitted work included) into `dir`, detached. An
   * ignored top-level node_modules is linked (directory junction) so tests can run without a reinstall.
   */
  async addWorktree(dir: string, commit: string): Promise<void> {
    await this.assertCheckpoint(commit)
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await this.run(['worktree', 'add', '--detach', dir, commit])
    const deps = path.join(this.root(), 'node_modules')
    const ignored = await this.run(['check-ignore', '-q', 'node_modules']).then(() => true, () => false)
    if (ignored && (await fs.stat(deps).catch(() => null))?.isDirectory()) {
      await fs.symlink(deps, path.join(dir, 'node_modules'), 'junction').catch(() => undefined)
    }
  }

  /** Delete a worktree. The node_modules junction is unlinked first so the workspace's own copy is never touched. */
  async removeWorktree(dir: string): Promise<void> {
    const link = path.join(dir, 'node_modules')
    if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) await fs.unlink(link)
    await this.run(['worktree', 'remove', '--force', dir]).catch(async () => {
      await fs.rm(dir, { recursive: true, force: true })
      await this.run(['worktree', 'prune']).catch(() => undefined)
    })
  }

  /**
   * The real changes since a checkpoint, as text for a prompt: `--stat` summary plus the patch, cut to `maxChars`.
   * `dir` is a worktree, or the workspace when omitted.
   */
  async diffText(base: string, dir?: string, maxChars = 12000): Promise<string> {
    await this.assertCheckpoint(base)
    const tree = await this.snapshotTree(dir)
    const stat = (await this.run(['diff', '--stat=120', `${base}^{tree}`, tree])).trim()
    if (!stat) return ''
    const patch = await this.run(['diff', '--no-color', '-U2', `${base}^{tree}`, tree])
    const room = Math.max(0, maxChars - stat.length - 40)
    return `${stat}\n\n${patch.length > room ? `${patch.slice(0, room)}\n… (diff cut at ${room} characters)` : patch}`
  }

  /** Files a worktree changed relative to the checkpoint it started from. */
  async worktreeChanges(base: string, dir: string): Promise<ChangedFile[]> {
    return this.diffTrees(`${base}^{tree}`, await this.snapshotTree(dir))
  }

  /**
   * Three-way merge of a worktree's changes into the workspace. A file the operator did not touch since the
   * checkpoint simply takes the worktree's version; a file changed on both sides is merged with
   * `git merge-file` (conflict markers left in place and reported), binary files on both sides are reported
   * and keep the workspace version.
   */
  async mergeWorktree(base: string, dir: string): Promise<MergeResult> {
    await this.assertCheckpoint(base)
    const result: MergeResult = { applied: [], conflicts: [] }
    const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b))
    const isBinary = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0)
    for (const f of await this.worktreeChanges(base, dir)) {
      const target = resolveInWorkspace(this.root(), f.path)
      const ours = await fs.readFile(target).catch(() => null)
      const original = await this.blob(base, f.path)
      const theirs = f.status === 'D' ? null : await fs.readFile(resolveInWorkspace(dir, f.path))
      if (same(ours, theirs)) continue
      if (same(ours, original)) {
        if (theirs === null) await fs.rm(target, { force: true })
        else {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, theirs)
        }
        result.applied.push(f.path)
        continue
      }
      if (ours === null || theirs === null || isBinary(ours) || isBinary(theirs) || isBinary(original)) {
        result.conflicts.push(f.path)
        continue
      }
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-merge-'))
      try {
        const [o, b, t] = ['ours', 'base', 'theirs'].map(n => path.join(tmp, n))
        await Promise.all([fs.writeFile(o, ours), fs.writeFile(b, original ?? Buffer.alloc(0)), fs.writeFile(t, theirs)])
        const merged = await new Promise<{ text: string; conflicts: number }>((resolve, reject) =>
          execFile(
            'git',
            ['merge-file', '-p', '-L', 'workspace', '-L', 'checkpoint', '-L', 'agent', o, b, t],
            { cwd: this.root(), maxBuffer: 256 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
              const code = (err as { code?: unknown } | null)?.code
              // Exit status = number of conflicts (capped at 127); errors exit with a negative value (255).
              if (err && !(typeof code === 'number' && code > 0 && code < 128)) reject(err)
              else resolve({ text: stdout, conflicts: typeof code === 'number' ? code : 0 })
            },
          ),
        )
        await fs.writeFile(target, merged.text)
        ;(merged.conflicts > 0 ? result.conflicts : result.applied).push(f.path)
      } finally {
        await fs.rm(tmp, { recursive: true, force: true })
      }
    }
    return result
  }

  async checkpoint(label: string): Promise<Checkpoint> {
    if (!(await this.isRepo())) throw new Error('Workspace is not a git repository')
    const tree = await this.snapshotTree()
    const head = (await this.run(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
    const msg = `NETRUNNER checkpoint: ${label.replace(/\s+/g, ' ').slice(0, 200)}`
    const ident = { GIT_AUTHOR_NAME: 'NETRUNNER', GIT_AUTHOR_EMAIL: 'netrunner@localhost', GIT_COMMITTER_NAME: 'NETRUNNER', GIT_COMMITTER_EMAIL: 'netrunner@localhost' }
    const commit = (await this.run(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg], { env: ident })).trim()
    const time = new Date()
    const ref = `${REF_PREFIX}${time.toISOString().replace(/[:.]/g, '-')}`
    await this.run(['update-ref', ref, commit])
    return { ref, commit, label, time: time.toISOString() }
  }

  async checkpoints(): Promise<Checkpoint[]> {
    if (!(await this.isRepo())) return []
    const out = await this.run(['for-each-ref', '--sort=-refname', '--format=%(refname)%00%(objectname)%00%(subject)%00%(creatordate:iso-strict)', REF_PREFIX])
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [ref, commit, subject, time] = line.split('\0')
        return { ref, commit, label: subject.replace(/^NETRUNNER checkpoint: /, ''), time }
      })
  }

  private async assertCheckpoint(commit: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid checkpoint id')
    const known = await this.checkpoints()
    if (!known.some(c => c.commit === commit)) throw new Error('Unknown checkpoint')
  }

  /** Files changed in the working tree since the checkpoint. */
  async changes(commit: string): Promise<ChangedFile[]> {
    await this.assertCheckpoint(commit)
    return this.diffTrees(`${commit}^{tree}`, await this.snapshotTree())
  }

  async fileVersions(commit: string, relPath: string): Promise<FileVersions> {
    await this.assertCheckpoint(commit)
    const abs = resolveInWorkspace(this.root(), relPath)
    const original = await this.run(['show', `${commit}:${relPath}`]).catch(() => '')
    const modified = await fs.readFile(abs, 'utf8').catch(() => '')
    return { path: relPath, original, modified }
  }

  /**
   * Restore the working tree to the checkpoint: files the agent created are deleted, modified and
   * deleted files are written back. Ignored files are left alone; index and HEAD are untouched.
   */
  async restore(commit: string): Promise<void> {
    const changes = await this.changes(commit)
    for (const f of changes.filter(c => c.status === 'A')) {
      await fs.rm(resolveInWorkspace(this.root(), f.path), { force: true })
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-idx-'))
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
    try {
      await this.run(['read-tree', commit], { env })
      const restore = changes.filter(c => c.status !== 'A').map(c => c.path)
      if (restore.length) await this.run(['checkout-index', '-f', '--', ...restore], { env })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }
}
