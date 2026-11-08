import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NetworkMode } from '../../shared/ipc'
import { assertOnlineAllowed } from './endpoint-policy'
import { traffic } from './traffic'

const run = promisify(execFile)

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  /** "sha256:<hex>", published by GitHub for release assets. */
  digest?: string | null
}

/** The published SHA-256 of an asset, or null when the release carries none. */
export function assetSha256(a: ReleaseAsset): string | null {
  const m = a.digest?.match(/^sha256:([0-9a-f]{64})$/i)
  return m ? m[1].toLowerCase() : null
}

/** Build tags compare by number (b12020 < b12052); null when the name is not a build tag. */
export function buildNumber(tag: string | null): number | null {
  const m = tag?.match(/^b(\d+)$/)
  return m ? Number(m[1]) : null
}

export interface Release {
  tag_name: string
  published_at?: string
  assets: ReleaseAsset[]
}

/**
 * The newest build (b<NNNN>) with Windows x64 binaries. GitHub's "latest" release of llama.cpp is now a stable
 * version (v0.x) without them, and the builds NETRUNNER runs are published as pre-releases.
 */
export function newestBuild(releases: Release[]): Release | null {
  return (
    releases
      .filter(r => buildNumber(r.tag_name) !== null && pickRuntimeAssets(r.tag_name, r.assets, true).length > 0)
      .sort((a, b) => buildNumber(b.tag_name)! - buildNumber(a.tag_name)!)[0] ?? null
  )
}

async function latestRelease(): Promise<Release> {
  const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20', { headers: { 'User-Agent': 'NETRUNNER', Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`)
  const rel = newestBuild((await res.json()) as Release[])
  if (!rel) throw new Error('No llama.cpp build with Windows x64 binaries among the 20 newest releases')
  return rel
}

/** What is installed (the newest b<NNNN> folder) and what GitHub calls the latest release. */
export async function checkRuntimeUpdate(
  root: string,
  mode: NetworkMode,
  log: (host: string, detail: string) => void,
): Promise<{ installed: string | null; latest: string; publishedAt: string | null; newer: boolean }> {
  assertOnlineAllowed(mode, 'Runtime update check')
  const installed =
    fs.existsSync(root)
      ? (fs.readdirSync(root).filter(d => buildNumber(d) !== null && fs.existsSync(path.join(root, d, 'llama-server.exe'))).sort((a, b) => buildNumber(b)! - buildNumber(a)!)[0] ?? null)
      : null
  log('api.github.com', 'llama.cpp releases (update check)')
  const rel = await latestRelease()
  const have = buildNumber(installed)
  const latest = buildNumber(rel.tag_name)
  return { installed, latest: rel.tag_name, publishedAt: rel.published_at ?? null, newer: latest !== null && (have === null || latest > have) }
}

/**
 * Assets to install from an official ggml-org/llama.cpp release: the CUDA build plus its CUDA runtime
 * DLLs when an NVIDIA GPU is present, otherwise the CPU build. Windows x64 only.
 */
export function pickRuntimeAssets(tag: string, assets: ReleaseAsset[], nvidia: boolean): ReleaseAsset[] {
  if (nvidia) {
    const cuda = assets
      .filter(a => new RegExp(`^llama-${tag}-bin-win-cuda-([\\d.]+)-x64\\.zip$`).test(a.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0]
    if (cuda) {
      const ver = cuda.name.match(/cuda-([\d.]+)-x64/)![1]
      const rt = assets.find(a => a.name === `cudart-llama-bin-win-cuda-${ver}-x64.zip`)
      return rt ? [cuda, rt] : [cuda]
    }
  }
  const cpu = assets.find(a => a.name === `llama-${tag}-bin-win-cpu-x64.zip`)
  return cpu ? [cpu] : []
}

/**
 * Download and unpack the latest llama.cpp release into <root>/<tag>. Returns the folder.
 * crtDir: the Visual C++ runtime DLLs bundled with NETRUNNER (msvcp140, vcruntime140, vcruntime140_1). llama.cpp's
 * official build links against them and a clean Windows does not have them, so they are copied next to llama-server.
 */
export async function installRuntime(root: string, mode: NetworkMode, log: (host: string, detail: string) => void, crtDir?: string): Promise<string> {
  assertOnlineAllowed(mode, 'Runtime download')
  log('api.github.com', 'llama.cpp releases')
  const rel = await latestRelease()
  const nvidia = await run('nvidia-smi', ['-L'], { timeout: 5000, windowsHide: true }).then(() => true, () => false)
  const assets = pickRuntimeAssets(rel.tag_name, rel.assets, nvidia)
  if (!assets.length) throw new Error(`No Windows x64 build in llama.cpp ${rel.tag_name}`)
  // Every archive is checked against the SHA-256 GitHub publishes for it; without one nothing is installed.
  const unverifiable = assets.filter(a => !assetSha256(a)).map(a => a.name)
  if (unverifiable.length) throw new Error(`llama.cpp ${rel.tag_name}: no published SHA-256 for ${unverifiable.join(', ')}; not installed`)
  const dir = path.join(root, rel.tag_name)
  const staging = `${dir}.partial`
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  for (const a of assets) {
    log('github.com', a.name)
    const res = await fetch(a.browser_download_url)
    if (!res.ok || !res.body) throw new Error(`download ${a.name}: HTTP ${res.status}`)
    const zip = path.join(staging, a.name)
    const body = Buffer.from(await res.arrayBuffer())
    traffic.add('runtime-download', 0, body.length)
    await fsp.writeFile(zip, body)
    if ((await fsp.stat(zip)).size !== a.size) throw new Error(`download ${a.name}: size mismatch`)
    const sha = crypto.createHash('sha256').update(await fsp.readFile(zip)).digest('hex')
    if (sha !== assetSha256(a)) {
      await fsp.rm(staging, { recursive: true, force: true })
      throw new Error(`download ${a.name}: SHA-256 mismatch (got ${sha}, published ${assetSha256(a)}); not installed`)
    }
    log('github.com', `${a.name} SHA-256 verified`)
    // Windows 10+ ships bsdtar, which extracts zip archives.
    await run('tar', ['-xf', zip, '-C', staging], { timeout: 10 * 60_000, windowsHide: true })
    await fsp.rm(zip)
  }
  if (!fs.existsSync(path.join(staging, 'llama-server.exe'))) throw new Error('llama-server.exe missing after extraction')
  await addCrt(staging, crtDir)
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.rename(staging, dir)
  return dir
}

/** Copies the bundled Visual C++ runtime DLLs into a llama.cpp folder where they are missing. Returns what it copied. */
export async function addCrt(runtimeDir: string, crtDir?: string): Promise<string[]> {
  if (!crtDir || !fs.existsSync(crtDir)) return []
  const copied: string[] = []
  for (const name of await fsp.readdir(crtDir)) {
    if (!name.toLowerCase().endsWith('.dll') || fs.existsSync(path.join(runtimeDir, name))) continue
    await fsp.copyFile(path.join(crtDir, name), path.join(runtimeDir, name))
    copied.push(name)
  }
  return copied
}
