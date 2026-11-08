import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NetworkMode } from '../../shared/ipc'
import { assertOnlineAllowed } from './endpoint-policy'
import { assetSha256, type ReleaseAsset } from './runtime-install'

const run = promisify(execFile)
const EXE = process.platform === 'win32' ? 'rg.exe' : 'rg'

/**
 * ripgrep for the agents' grep/glob tools. OpenCode looks for `rg` on PATH and otherwise tries to download it,
 * which NETRUNNER's offline policy blocks. Order: NETRUNNER's own copy, then any ripgrep already on PATH.
 */
export function findRipgrep(ownDir: string, pathEnv = process.env.PATH ?? process.env.Path ?? ''): string | null {
  const candidates = [path.join(ownDir, EXE), ...pathEnv.split(path.delimiter).filter(Boolean).map(d => path.join(d, EXE))]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

/** The asset with the Windows x64 MSVC build in an official BurntSushi/ripgrep release. */
export function pickRipgrepAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return assets.find(a => /^ripgrep-[\d.]+-x86_64-pc-windows-msvc\.zip$/.test(a.name)) ?? null
}

/** Environment with `dir` first on PATH, whatever the variable's casing (Windows uses "Path"). */
export function withPathFirst(env: Record<string, string>, dir: string): Record<string, string> {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: [dir, env[key]].filter(Boolean).join(path.delimiter) }
}

/** Download the latest official ripgrep release and put rg.exe into `dir`. ONLINE TOOLS only. */
export async function installRipgrep(dir: string, mode: NetworkMode, log: (host: string, detail: string) => void): Promise<string> {
  assertOnlineAllowed(mode, 'ripgrep download')
  log('api.github.com', 'ripgrep latest release')
  const rel = (await (await fetch('https://api.github.com/repos/BurntSushi/ripgrep/releases/latest', { headers: { 'User-Agent': 'NETRUNNER' } })).json()) as {
    tag_name: string
    assets: ReleaseAsset[]
  }
  const asset = pickRipgrepAsset(rel.assets)
  if (!asset) throw new Error(`No Windows x64 build in ripgrep ${rel.tag_name}`)
  if (!assetSha256(asset)) throw new Error(`ripgrep ${rel.tag_name}: no published SHA-256 for ${asset.name}; not installed`)
  const staging = `${dir}.partial`
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  log('github.com', asset.name)
  const res = await fetch(asset.browser_download_url)
  if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`)
  const zip = path.join(staging, asset.name)
  await fsp.writeFile(zip, Buffer.from(await res.arrayBuffer()))
  if ((await fsp.stat(zip)).size !== asset.size) throw new Error(`download ${asset.name}: size mismatch`)
  const sha = crypto.createHash('sha256').update(await fsp.readFile(zip)).digest('hex')
  if (sha !== assetSha256(asset)) {
    await fsp.rm(staging, { recursive: true, force: true })
    throw new Error(`download ${asset.name}: SHA-256 mismatch; not installed`)
  }
  await run('tar', ['-xf', zip, '-C', staging], { timeout: 5 * 60_000, windowsHide: true })
  const inner = path.join(staging, asset.name.replace(/\.zip$/, ''), EXE)
  if (!fs.existsSync(inner)) throw new Error('rg.exe missing after extraction')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.copyFile(inner, path.join(dir, EXE))
  await fsp.rm(staging, { recursive: true, force: true })
  const { stdout } = await run(path.join(dir, EXE), ['--version'], { timeout: 10000, windowsHide: true })
  return stdout.split('\n')[0].trim()
}
