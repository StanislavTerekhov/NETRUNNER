// Live: after a tool says NO_INTERNET the chat model gets no more tools and answers at once.
// Opt-in: NETRUNNER_LIVE=1 [NETRUNNER_LIVE_MODEL=<model id fragment>] npx vitest run test/no-internet.live.test.ts --silent=false
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatChunk } from '../electron/shared/ipc'
import { findRuntimeDir, LlamaRuntime } from '../electron/main/services/llamacpp'
import { NoInternetError, WEB_TOOL_DEFS } from '../electron/main/services/web-tools'

const home = path.join(os.homedir(), 'NETRUNNER')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('no internet (live chat loop)', () => {
  it('one tool call, then a plain answer', async () => {
    const want = process.env.NETRUNNER_LIVE_MODEL ?? 'qwen3.5-4b-base'
    const model = (await runtime.catalog.list()).find(m => m.id.includes(want))!.id
    let calls = 0
    const chunks: ChatChunk[] = []
    const t0 = Date.now()
    await new Promise<void>(resolve => {
      runtime.startChat(
        { model, messages: [{ role: 'user', content: 'What is the latest release tag of llama.cpp on GitHub? Look it up.' }], think: false, contextLength: 8192, temperature: 0, web: true },
        c => {
          chunks.push(c)
          if (c.done) resolve()
        },
        { defs: WEB_TOOL_DEFS, run: async () => (calls++, `Error: ${new NoInternetError().message}`) },
      )
    })
    const text = chunks.map(c => c.content).join('')
    const done = chunks.find(c => c.done)!
    console.log(`[no-internet] tool calls ${calls}, ${((Date.now() - t0) / 1000).toFixed(1)} s, error ${done.error}\n${text.slice(0, 600)}`)
    expect(done.error).toBeNull()
    expect(calls).toBe(1)
    expect(text.trim().length).toBeGreaterThan(0)
  }, 300_000)
})
