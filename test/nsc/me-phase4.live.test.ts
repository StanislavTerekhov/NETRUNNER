// NSC-ME phase 4 (H3, state preservation): does llama-server's slot save/restore keep the full state of the
// hybrid Coder-Next (attention KV + recurrent state + context checkpoints), so that a model brought back after an
// unload continues a ~7K-token conversation without reading it again?
// Per rep (agent settings: 65K × 2 slots, slot 0):
//   live     R1 (long prompt + question) → save slot → R2 (follow-up) on the same server: reference
//   restored unload → load → restore slot → R2
//   fresh    unload → load → R2 without restore: the cost of recomputing the context
// The six checks of NSC-ME 0.4 §7: saved, restored, used (R2 prompt_n small), no full prefill, output within the
// tolerance set by live vs fresh, and restore faster than recomputing.
//   NETRUNNER_LIVE=1 [NSC_REPS=3] npx vitest run test/nsc/me-phase4.live.test.ts --silent=false
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'me', 'phase4')
const slotDir = path.join(outDir, 'slots')
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

const root = path.resolve(import.meta.dirname, '..', '..')
const DOC = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'llamacpp.ts'), 'utf8').slice(0, 26000)
const SYS = 'You are a senior engineer reviewing a TypeScript code base. Answer precisely and briefly.'
const Q1 = 'Which function builds the llama-server command line, and which options does it add for MoE models?'
const Q2 = 'Now list, as a short bullet list, every environment variable this file reads.'
const REPS = Number(process.env.NSC_REPS || 3)
const MATCH = 'Qwen3-Coder-Next-Q4_K_M-00001'

type Srv = { url: string; key: string }
type Tok = { token: string; logprob: number }
async function chat(s: Srv, model: string, messages: { role: string; content: string }[], max: number) {
  const t0 = Date.now()
  const res = await fetch(`${s.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model, messages, max_tokens: max, temperature: 0, cache_prompt: true, id_slot: 0, logprobs: true, top_logprobs: 1, chat_template_kwargs: { enable_thinking: false } }),
  })
  const j = (await res.json()) as { choices: { message: { content: string }; logprobs?: { content?: Tok[] } }[]; timings?: Record<string, number> }
  const tm = j.timings ?? {}
  return {
    wallMs: Date.now() - t0,
    text: j.choices[0].message.content,
    tokens: (j.choices[0].logprobs?.content ?? []).map(t => ({ token: t.token, logprob: t.logprob })),
    promptN: tm.prompt_n,
    cacheN: tm.cache_n ?? null,
    promptMs: Math.round(tm.prompt_ms),
  }
}
async function slotAction(s: Srv, action: 'save' | 'restore', filename: string) {
  const res = await fetch(`${s.url}/slots/0?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ filename }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
/** Same tokens up to where they first differ; the largest top-1 log-probability gap over the shared part. */
function diff(a: Tok[], b: Tok[]) {
  let same = 0
  while (same < Math.min(a.length, b.length) && a[same].token === b[same].token) same++
  let maxLp = 0
  for (let i = 0; i < same; i++) maxLp = Math.max(maxLp, Math.abs(a[i].logprob - b[i].logprob))
  return { sameTokens: same, of: Math.min(a.length, b.length), identical: same === a.length && a.length === b.length, maxLogprobGap: Math.round(maxLp * 1e4) / 1e4 }
}

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC-ME phase 4: slot save/restore on hybrid Coder-Next', () => {
  it('restores the conversation state after an unload', async () => {
    fs.mkdirSync(slotDir, { recursive: true })
    process.env.NETRUNNER_SERVER_EXTRA_ARGS = `--slot-save-path ${slotDir}`
    const entry = (await runtime.catalog.list()).find(e => e.id.includes(MATCH))
    if (!entry) throw new Error('Coder-Next not found')
    const load = async () => {
      const t = Date.now()
      const s = await runtime.ensure('chat', entry.id, 65536, 2)
      return { s, loadMs: Date.now() - t }
    }
    const reps: Record<string, unknown>[] = []
    for (let r = 0; r < REPS; r++) {
      const file = `cn-rep${r}.bin`
      // live
      let { s } = await load()
      const m1 = [{ role: 'system', content: SYS }, { role: 'user', content: `${DOC}\n\n${Q1}` }]
      const r1 = await chat(s, entry.id, m1, 48)
      const save = await slotAction(s, 'save', file)
      const fileMiB = Math.round((fs.statSync(path.join(slotDir, file)).size / 2 ** 20) * 10) / 10
      const m2 = [...m1, { role: 'assistant', content: r1.text }, { role: 'user', content: Q2 }]
      const live = await chat(s, entry.id, m2, 64)
      await runtime.stopAll()
      // restored
      const tR = Date.now()
      const l2 = await load()
      s = l2.s
      const restore = await slotAction(s, 'restore', file)
      const restoreWall = Date.now() - tR - l2.loadMs
      const restored = await chat(s, entry.id, m2, 64)
      const restoredTotalMs = Date.now() - tR
      await runtime.stopAll()
      // fresh
      const tF = Date.now()
      const l3 = await load()
      const fresh = await chat(l3.s, entry.id, m2, 64)
      const freshTotalMs = Date.now() - tF
      await runtime.stopAll()
      const rep = {
        r1: { promptN: r1.promptN, promptMs: r1.promptMs },
        save: { status: save.status, ...save.body, fileMiB },
        live: { promptN: live.promptN, cacheN: live.cacheN, promptMs: live.promptMs, wallMs: live.wallMs },
        restore: { status: restore.status, ...restore.body, wallMs: restoreWall, loadMs: l2.loadMs },
        restored: { promptN: restored.promptN, cacheN: restored.cacheN, promptMs: restored.promptMs, wallMs: restored.wallMs, totalMs: restoredTotalMs },
        fresh: { promptN: fresh.promptN, cacheN: fresh.cacheN, promptMs: fresh.promptMs, wallMs: fresh.wallMs, totalMs: freshTotalMs, loadMs: l3.loadMs },
        restoredVsLive: diff(live.tokens, restored.tokens),
        freshVsLive: diff(live.tokens, fresh.tokens),
        texts: { live: live.text, restored: restored.text, fresh: fresh.text },
      }
      reps.push(rep)
      const { texts: _t, ...short } = rep
      console.log(`[me4] rep${r} ${JSON.stringify(short)}`)
    }
    delete process.env.NETRUNNER_SERVER_EXTRA_ARGS
    fs.writeFileSync(path.join(outDir, 'phase4.json'), JSON.stringify({ date: new Date().toISOString(), model: entry.id, promptChars: DOC.length, reps }, null, 2))
    expect(reps).toHaveLength(REPS)
  }, 60 * 60_000)
})
