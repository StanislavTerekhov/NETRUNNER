// Live: chat speed with the default server settings (16K + q8 KV, MTP when a dense model runs largely from RAM),
// Coder-Next prewarm, and chat answered by the pinned agent model without a reload.
// Opt-in: NETRUNNER_LIVE=1 npx vitest run test/runtime-speed.live.test.ts --silent=false
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatChunk } from '../electron/shared/ipc'
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

const IQ3 = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-IQ3_XXS.gguf'
const Q4 = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf'
const CODER = 'Qwen/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf'
const PROMPT = 'Write a Python function that parses an ISO 8601 date string and returns a datetime, with error handling. Then explain it briefly.'

function chat(model: string, content = PROMPT): Promise<{ tps: number; served: string | undefined; loadMs: number; firstTokenMs: number }> {
  const t0 = Date.now()
  let first = 0
  return new Promise((resolve, reject) => {
    runtime.startChat({ model, messages: [{ role: 'user', content }], think: false, contextLength: null, temperature: 0 }, (c: ChatChunk) => {
      if (!first && c.content) first = Date.now() - t0
      if (!c.done) return
      if (c.error) reject(new Error(c.error))
      else resolve({ tps: c.metrics?.tokensPerSecond ?? 0, served: c.servedModel, loadMs: c.metrics?.loadMs ?? 0, firstTokenMs: first })
    })
  })
}

describe.skipIf(!LIVE)('runtime speed (live)', () => {
  it(
    'Qwen 27B IQ3_XXS with the default 16K + q8 KV cache',
    async () => {
      await chat(IQ3, 'hi') // load
      const r = await chat(IQ3)
      const s = runtime.serverFor('chat')!
      console.log(`[iq3] ctx ${s.ctx}, mtp ${s.mtp}: ${r.tps.toFixed(1)} tok/s`)
      expect(s.ctx).toBe(16384)
      expect(s.mtp).toBe(false)
      expect(r.tps).toBeGreaterThan(10)
    },
    10 * 60_000,
  )

  it(
    'Qwen 27B Q4_K_M turns on MTP speculative decoding by itself',
    async () => {
      await chat(Q4, 'hi')
      const r = await chat(Q4)
      const s = runtime.serverFor('chat')!
      console.log(`[q4] ctx ${s.ctx}, mtp ${s.mtp}: ${r.tps.toFixed(1)} tok/s`)
      expect(s.mtp).toBe(true)
      expect(r.tps).toBeGreaterThan(6)
    },
    10 * 60_000,
  )

  it(
    'agent model: prewarm, then chat for the 27B is answered by it without a reload',
    async () => {
      const t0 = Date.now()
      await runtime.ensure('chat', CODER, 65536, 2)
      runtime.pinned = CODER
      const loadS = (Date.now() - t0) / 1000
      const warm = await runtime.prewarm(CODER)
      console.log(`[coder] load ${loadS.toFixed(0)} s, prewarm ${(warm.bytes / 2 ** 30).toFixed(1)} GiB in ${(warm.ms / 1000).toFixed(0)} s`)
      const first = await chat(CODER)
      console.log(`[coder] first answer after prewarm: ${first.tps.toFixed(1)} tok/s, first token ${first.firstTokenMs} ms`)
      const routed = await chat(IQ3, 'Ответь одним словом: какой язык программирования у файла main.py?')
      console.log(`[routed] asked ${IQ3}, served by ${routed.served}: ${routed.tps.toFixed(1)} tok/s, load ${routed.loadMs} ms, first token ${routed.firstTokenMs} ms`)
      expect(routed.served).toBe(CODER)
      expect(routed.loadMs).toBe(0)
      expect(first.tps).toBeGreaterThan(10)
      runtime.pinned = null
    },
    20 * 60_000,
  )
})
