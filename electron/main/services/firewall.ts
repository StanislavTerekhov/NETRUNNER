import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FirewallProgram, FirewallStatus } from '../../shared/ipc'

const run = promisify(execFile)
/** Every rule NETRUNNER writes starts with this; nothing else in Windows Firewall is ever touched. */
export const RULE_PREFIX = 'NETRUNNER - '
/** The single rule of versions before 1.7, removed by every apply. */
export const LEGACY_RULE_NAME = 'NETRUNNER - block OpenCode internet access'

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** One rule per program; the path hash keeps two programs with the same file name apart. */
export function ruleName(program: string): string {
  const hash = crypto.createHash('sha256').update(program.toLowerCase()).digest('hex').slice(0, 8)
  return `${RULE_PREFIX}block internet: ${path.basename(program)} (${hash})`
}

/**
 * PowerShell that makes Windows Firewall hold exactly the wanted NETRUNNER rules. "Internet" excludes loopback and
 * the local subnet, so local model servers and the LAN keep working; a direct internet connection by a listed program
 * is dropped by the OS, even when it ignores the NETRUNNER proxy. The operator's other rules are never touched.
 */
export function firewallSyncCommand(programs: string[]): string {
  const remove = `Get-NetFirewallRule -DisplayName ${psQuote(`${RULE_PREFIX}*`)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`
  const add = programs.map(
    p => `New-NetFirewallRule -DisplayName ${psQuote(ruleName(p))} -Direction Outbound -Program ${psQuote(p)} -RemoteAddress Internet -Action Block -Profile Any | Out-Null`,
  )
  return [remove, ...add].join('; ')
}

/** -EncodedCommand takes base64 of UTF-16LE, which avoids every quoting problem across the elevation hop. */
export function encodePowerShell(cmd: string): string {
  return Buffer.from(cmd, 'utf16le').toString('base64')
}

export interface FirewallDeps {
  /** NETRUNNER's own programs: the agent engine, the model runtime, ripgrep (those that exist on this machine). */
  builtin(): { path: string; label: string }[]
  wanted(): { blocked: string[]; custom: string[] }
}

export class FirewallService {
  constructor(private readonly deps: FirewallDeps) {}

  /** The programs NETRUNNER rules block right now (reading rules needs no administrator rights). */
  private async activePrograms(): Promise<string[]> {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-NetFirewallRule -DisplayName ${psQuote(`${RULE_PREFIX}*`)} -ErrorAction SilentlyContinue | Where-Object Enabled -eq 'True' | Get-NetFirewallApplicationFilter | ForEach-Object Program) | ConvertTo-Json -Compress`,
      ],
      { timeout: 20000, windowsHide: true },
    )
    const parsed = stdout.trim() ? (JSON.parse(stdout) as string | string[] | null) : []
    return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map(p => p.toLowerCase())
  }

  programs(active: string[] = []): FirewallProgram[] {
    const { blocked, custom } = this.deps.wanted()
    const want = new Set(blocked.map(p => p.toLowerCase()))
    const list = [...this.deps.builtin().map(b => ({ ...b, builtin: true })), ...custom.map(p => ({ path: p, label: path.basename(p), builtin: false }))]
    const seen = new Set<string>()
    return list
      .filter(p => !seen.has(p.path.toLowerCase()) && seen.add(p.path.toLowerCase()))
      .map(p => ({ ...p, wanted: want.has(p.path.toLowerCase()), active: active.includes(p.path.toLowerCase()), exists: fs.existsSync(p.path) }))
  }

  async status(): Promise<FirewallStatus> {
    if (process.platform !== 'win32') return { supported: false, programs: this.programs(), pending: false, detail: 'Windows Firewall integration is Windows-only' }
    try {
      const programs = this.programs(await this.activePrograms())
      const n = programs.filter(p => p.active).length
      return {
        supported: true,
        programs,
        pending: programs.some(p => p.wanted !== p.active),
        detail: n ? `${n} program(s) blocked from the internet by Windows Firewall` : 'No NETRUNNER rule in Windows Firewall; only the NETRUNNER proxy applies',
      }
    } catch (err) {
      return { supported: true, programs: this.programs(), pending: false, detail: `Could not read firewall rules: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` }
    }
  }

  /** Writes the wanted rules ('sync') or removes them all ('clear') in an elevated PowerShell; Windows asks with UAC. */
  async apply(what: 'sync' | 'clear'): Promise<FirewallStatus> {
    const programs = what === 'clear' ? [] : this.programs().filter(p => p.wanted && p.exists).map(p => p.path)
    const inner = encodePowerShell(firewallSyncCommand(programs))
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}'`],
      { timeout: 120000, windowsHide: true },
    )
    return this.status()
  }
}
