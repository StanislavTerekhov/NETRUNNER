// NSC-ME У2 + У3 end to end, through NETRUNNER's own runtime code: a long conversation on Coder-Next (agent settings,
// requests WITHOUT id_slot, as the app and OpenCode send them) → idle unload by idleSweep() (saves the slots) → the next
// request loads the model again, the runtime restores the slots, and the server must find the conversation by itself.
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/me-u3.live.test.ts --silent=false
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const slotsDir = path.join(home, 'nsc', 'me', 'u3', 'slots')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
  slotsDir,
})
afterAll(() => runtime.stopAll())

const root = path.resolve(import.meta.dirname, '..', '..')
const DOC = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'llamacpp.ts'), 'utf8').slice(0, 26000)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME У2+У3: idle unload keeps the conversation', () => {
  it('restores the conversation after an idle unload, found without id_slot', async () => {
    fs.rmSync(slotsDir, { recursive: true, force: true })
    const id = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))!.id
    const chat = async (messages: { role: string; content: string }[]) => {
      const s = await runtime.ensure('chat', id, 65536, 2)
      const t = Date.now()
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
        body: JSON.stringify({ model: id, messages, max_tokens: 48, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
      })
      const j = (await res.json()) as { choices: { message: { content: string } }[]; timings: Record<string, number> }
      return { text: j.choices[0].message.content, promptN: j.timings.prompt_n, cacheN: j.timings.cache_n, promptMs: Math.round(j.timings.prompt_ms), wallMs: Date.now() - t }
    }
    const m1 = [{ role: 'system', content: 'You are a senior engineer. Answer briefly.' }, { role: 'user', content: `${DOC}\n\nWhich function builds the llama-server command line?` }]
    const r1 = await chat(m1)
    console.log(`[u3] first ${JSON.stringify({ ...r1, text: undefined })}`)
    await pause(4000)
    // largeMinutes 0.05 = 3 s, only to trigger the sweep now; the app allows 0/5/10/30/60/120.
    const unloaded = await runtime.idleSweep({ smallMinutes: 0, largeMinutes: 0.05 }, false)
    const files = fs.readdirSync(slotsDir)
    const sizes = files.map(f => Math.round(fs.statSync(path.join(slotsDir, f)).size / 2 ** 20))
    console.log(`[u3] sweep ${JSON.stringify(unloaded)} files ${JSON.stringify(files)} MiB ${JSON.stringify(sizes)}`)
    expect(unloaded).toHaveLength(1)
    expect(unloaded[0].savedSlots).toBe(1)
    expect(runtime.serverFor('chat')).toBeNull()
    const m2 = [...m1, { role: 'assistant', content: r1.text }, { role: 'user', content: 'And which environment variables does it read?' }]
    const t = Date.now()
    const r2 = await chat(m2)
    const back = Date.now() - t
    console.log(`[u3] after return ${JSON.stringify({ ...r2, text: undefined, totalMs: back })} files left ${fs.readdirSync(slotsDir).length}`)
    // The restored conversation was found without id_slot: only the new turn was read.
    expect(r2.cacheN).toBeGreaterThan(r1.promptN)
    expect(r2.promptN).toBeLessThan(200)
    expect(fs.readdirSync(slotsDir)).toHaveLength(0)
    // Control: the same follow-up on a fresh load without saved state reads everything.
    await runtime.stopAll()
    const r3 = await chat(m2)
    console.log(`[u3] control without restore ${JSON.stringify({ ...r3, text: undefined })}`)
    expect(r3.promptN).toBeGreaterThan(r1.promptN)
  }, 30 * 60_000)
})
