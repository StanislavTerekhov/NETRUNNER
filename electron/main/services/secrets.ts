import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * API keys the user typed in (Brave, Google Custom Search), stored encrypted with the OS key store (Electron
 * safeStorage = Windows DPAPI, bound to this Windows user). They are read only in the main process.
 */
export class SecretStore {
  private data: Record<string, string> = {}
  private readonly file: string

  constructor(
    userDataDir: string,
    private readonly crypto: { encrypt(s: string): Buffer; decrypt(b: Buffer): string; available(): boolean },
  ) {
    this.file = path.join(userDataDir, 'secrets.json')
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, string>
      this.data = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string'))
    } catch {
      this.data = {}
    }
  }

  get(name: string): string | null {
    const v = this.data[name]
    if (!v) return null
    try {
      return this.crypto.decrypt(Buffer.from(v, 'base64'))
    } catch {
      return null
    }
  }

  has(name: string): boolean {
    return !!this.data[name]
  }

  async set(name: string, value: string | null): Promise<void> {
    if (value === null || !value.trim()) delete this.data[name]
    else {
      if (!this.crypto.available()) throw new Error('OS encryption is not available; the key was not stored')
      this.data[name] = this.crypto.encrypt(value.trim()).toString('base64')
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2))
  }
}
