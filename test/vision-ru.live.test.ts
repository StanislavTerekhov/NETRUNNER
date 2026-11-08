// Live: a picture in the chat (Qwen3.8-27B + its mmproj vision projector) and Russian questions / answers, through
// the same LlamaRuntime.startChat path NEURAL CORE uses. Opt-in: NETRUNNER_LIVE=1 npx vitest run test/vision-ru.live.test.ts
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatChunk, ChatMessage } from '../electron/shared/ipc'
import { findRuntimeDir, LlamaRuntime } from '../electron/main/services/llamacpp'

const LIVE = process.env.NETRUNNER_LIVE === '1'
const home = path.join(os.homedir(), 'NETRUNNER')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

const SYSTEM =
  "You are NETRUNNER, a senior software engineer assistant running fully locally on the user's Windows workstation. Answer precisely, prefer working code, and say when you are unsure. Never claim to have run code or tests you did not run. Reply in the language of the user's message (for example Russian or English); keep code, identifiers and commands as they are."

/** A PNG whose left half is red and right half blue (no image library needed). */
function twoColorPng(w = 256, h = 128): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) row.set(x < w / 2 ? [220, 20, 30] : [20, 40, 220], 1 + x * 3)
    rows.push(row)
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

function chat(model: string, messages: ChatMessage[]): Promise<{ text: string; tps: number }> {
  return new Promise((resolve, reject) => {
    let text = ''
    runtime.startChat({ model, messages, think: false, contextLength: 8192, temperature: 0 }, (c: ChatChunk) => {
      text += c.content
      if (!c.done) return
      if (c.error) reject(new Error(c.error))
      else resolve({ text: text.trim(), tps: c.metrics?.tokensPerSecond ?? 0 })
    })
  })
}

const cyrillicShare = (s: string) => {
  const letters = s.match(/\p{L}/gu) ?? []
  return letters.length ? letters.filter(ch => /\p{Script=Cyrillic}/u.test(ch)).length / letters.length : 0
}

describe.skipIf(!LIVE)('vision and Russian (live)', () => {
  const general = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-IQ3_XXS.gguf'

  it(
    'Qwen3.8-27B sees an attached picture and answers a Russian question in Russian',
    async () => {
      const r = await chat(general, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Какого цвета левая половина картинки и какого правая? Ответь одним коротким предложением.', images: [twoColorPng()] },
      ])
      console.log(`[vision] ${r.tps.toFixed(1)} tok/s: ${r.text}`)
      expect(r.text.toLowerCase()).toMatch(/красн/)
      expect(r.text.toLowerCase()).toMatch(/син/)
      expect(cyrillicShare(r.text)).toBeGreaterThan(0.8)
    },
    15 * 60_000,
  )

  it(
    'answers a Russian programming question in Russian (code stays code)',
    async () => {
      const r = await chat(general, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Что такое замыкание в JavaScript? Объясни в двух предложениях и дай пример из трёх строк кода.' },
      ])
      console.log(`[ru] ${r.tps.toFixed(1)} tok/s, cyrillic ${(cyrillicShare(r.text.replace(/```[\s\S]*?```/g, '')) * 100).toFixed(0)}%:\n${r.text}`)
      expect(cyrillicShare(r.text.replace(/```[\s\S]*?```/g, ''))).toBeGreaterThan(0.6)
      expect(r.text).toMatch(/function|=>/)
    },
    15 * 60_000,
  )

  it(
    'the fine-tuned 4B also answers in Russian',
    async () => {
      const r = await chat('netrunner/netrunner-qwen3.5-4b-Q4_K_M.gguf', [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'Кратко: для чего в NETRUNNER нужен FORGE?' },
      ])
      console.log(`[ru-4b] ${r.tps.toFixed(1)} tok/s: ${r.text.slice(0, 400)}`)
      expect(cyrillicShare(r.text)).toBeGreaterThan(0.6)
    },
    10 * 60_000,
  )

  it('refuses images for a model without a vision projector', async () => {
    await expect(chat('netrunner/netrunner-qwen3.5-4b-Q4_K_M.gguf', [{ role: 'user', content: 'what is this?', images: [twoColorPng(8, 8)] }])).rejects.toThrow(/cannot see images/)
  })
})
