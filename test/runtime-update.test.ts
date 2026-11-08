// llama.cpp updates: the newest build with Windows binaries (not GitHub's "latest", a stable v0.x without them)
// and the published SHA-256 that every download is checked against.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetSha256, buildNumber, checkRuntimeUpdate, newestBuild, type Release } from '../electron/main/services/runtime-install'

const asset = (name: string, digest: string | null = `sha256:${'a'.repeat(64)}`) => ({ name, browser_download_url: `https://x/${name}`, size: 1, digest })
const win = (tag: string) => [asset(`llama-${tag}-bin-win-cuda-13.4-x64.zip`), asset('cudart-llama-bin-win-cuda-13.4-x64.zip'), asset(`llama-${tag}-bin-win-cpu-x64.zip`)]

describe('llama.cpp release choice', () => {
  it('takes the newest b<NNNN> build that has Windows x64 binaries', () => {
    const releases: Release[] = [
      { tag_name: 'v0.8.0', assets: [asset('notes.txt')] },
      { tag_name: 'b12053', assets: [asset('llama-b12053-bin-ubuntu-x64.tar.gz')] },
      { tag_name: 'b12052', assets: win('b12052') },
      { tag_name: 'b12050', assets: win('b12050') },
    ]
    expect(newestBuild(releases)?.tag_name).toBe('b12052')
    expect(newestBuild([{ tag_name: 'v0.8.0', assets: [] }])).toBeNull()
  })

  it('reads build numbers and published SHA-256 values', () => {
    expect(buildNumber('b12020')).toBe(12020)
    expect(buildNumber('v0.8.0')).toBeNull()
    expect(assetSha256(asset('x', `sha256:${'AB'.repeat(32)}`))).toBe('ab'.repeat(32))
    expect(assetSha256(asset('x', null))).toBeNull()
    expect(assetSha256(asset('x', 'md5:abc'))).toBeNull()
  })

  it('refuses the update check outside ONLINE TOOLS', async () => {
    await expect(checkRuntimeUpdate(os.tmpdir(), 'strict-offline', () => undefined)).rejects.toThrow(/ONLINE TOOLS/)
  })
})

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('llama.cpp update check (live, GitHub API)', () => {
  it('finds a newer build than an old installed one, with SHA-256 on its files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-rt-'))
    fs.mkdirSync(path.join(root, 'b100'))
    fs.writeFileSync(path.join(root, 'b100', 'llama-server.exe'), '')
    try {
      const r = await checkRuntimeUpdate(root, 'online-tools', () => undefined)
      console.log(`[runtime] ${JSON.stringify(r)}`)
      expect(r.installed).toBe('b100')
      expect(r.latest).toMatch(/^b\d+$/)
      expect(r.newer).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
