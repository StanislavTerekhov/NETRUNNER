import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { IPty } from 'node-pty'
import type { PtyInfo } from '../../shared/ipc'

type PtyModule = typeof import('node-pty')

function pickShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL ?? '/bin/bash'
  const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  return fs.existsSync(pwsh) ? pwsh : 'powershell.exe'
}

/**
 * Interactive shells for the TERMINAL panel. Processes live in the main process (node-pty / ConPTY);
 * the renderer only sends keystrokes and receives output.
 */
/** Recent output kept per shell, replayed when the terminal panel is re-mounted (docked elsewhere). */
const BUFFER_CHARS = 200_000

export class PtyService {
  private readonly ptys = new Map<string, IPty>()
  private readonly buffers = new Map<string, string>()
  private seq = 0
  private mod: PtyModule | null = null

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, code: number) => void,
    private readonly extraEnv: () => Record<string, string> = () => ({}),
  ) {}

  private async load(): Promise<PtyModule> {
    this.mod ??= await import('node-pty')
    return this.mod
  }

  async create(cwd: string): Promise<PtyInfo> {
    const pty = await this.load()
    const shell = pickShell()
    const id = `pty-${++this.seq}`
    const proc = pty.spawn(shell, shell.toLowerCase().includes('powershell') || shell.endsWith('pwsh.exe') ? ['-NoLogo'] : [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...this.extraEnv() } as Record<string, string>,
      useConpty: true,
    })
    this.buffers.set(id, '')
    proc.onData(d => {
      const buf = (this.buffers.get(id) ?? '') + d
      this.buffers.set(id, buf.length > BUFFER_CHARS ? buf.slice(-BUFFER_CHARS) : buf)
      this.onData(id, d)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.buffers.delete(id)
      this.onExit(id, exitCode)
    })
    this.ptys.set(id, proc)
    return { id, shell, cwd }
  }

  /** Output so far of a live shell, or null when it has exited. */
  buffer(id: string): string | null {
    return this.ptys.has(id) ? (this.buffers.get(id) ?? '') : null
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && cols < 1000 && rows < 1000) this.ptys.get(id)?.resize(Math.floor(cols), Math.floor(rows))
  }

  /**
   * On Windows node-pty's kill() forks a helper through Electron-as-Node, which the RunAsNode fuse
   * disables in release builds. Killing the shell's process tree directly is also more thorough: commands
   * started from the shell (npm, test runners) end with it.
   */
  kill(id: string, sync = false): void {
    const proc = this.ptys.get(id)
    this.ptys.delete(id)
    this.buffers.delete(id)
    if (!proc) return
    if (process.platform === 'win32') {
      const args = ['/pid', String(proc.pid), '/T', '/F']
      if (sync) {
        try {
          execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
        } catch {
          // already gone
        }
      } else execFile('taskkill', args, { windowsHide: true }, () => undefined)
    } else proc.kill()
  }

  /**
   * At quit the trees are killed synchronously: node-pty closes its pseudo console when the app exits, and on Windows
   * that close blocks while the shell is still alive — the app then hung on quit (or crashed when forced to exit).
   */
  killAll(sync = false): void {
    for (const id of [...this.ptys.keys()]) this.kill(id, sync)
  }
}
