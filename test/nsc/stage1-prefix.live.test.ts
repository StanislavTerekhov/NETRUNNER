// NSC stage 1, check 1: does llama-server reuse a shared prompt prefix on Coder-Next? It is a hybrid model (recurrent
// + attention layers): its recurrent state cannot be cut back to an arbitrary token, so a partial prefix is reusable
// only from a saved checkpoint. Requests share a long prefix and differ at the end, in the same and in other slots.
//   NETRUNNER_LIVE=1 [NSC_EXTRA_ARGS="-cms 0 -ub 1024"] npx vitest run test/nsc/stage1-prefix.live.test.ts --silent=false
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime, serverArgs } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage1')
const binDir = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp'))
const runtime = new LlamaRuntime({ binaryDir: () => binDir, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })
const root = path.resolve(import.meta.dirname, '..', '..')
// ~6K tokens of shared context, like an agent's system prompt + tool definitions.
const shared = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'opencode.ts'), 'utf8').slice(0, 20000)
const unrelated = fs.readFileSync(path.join(root, 'electron', 'main', 'services', 'web-tools.ts'), 'utf8').slice(0, 20000)

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 1: prefix reuse on Coder-Next', () => {
  it('measures how much of a shared prefix is processed again', async () => {
    if (!binDir) throw new Error('llama.cpp runtime not found')
    fs.mkdirSync(outDir, { recursive: true })
    const entry = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    if (!entry) throw new Error('Coder-Next not found')
    const key = crypto.randomBytes(16).toString('hex')
    const port = 18091
    const url = `http://127.0.0.1:${port}`
    const log: string[] = []
    // NSC_EXTRA_ARGS: llama-server options to compare (checkpoint spacing, batch size); later ones override serverArgs.
    const extra = process.env.NSC_EXTRA_ARGS?.split(' ').filter(Boolean) ?? []
    const proc = spawn(path.join(binDir, 'llama-server.exe'), [...serverArgs(entry, port, key, 65536, 2), ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: binDir })
    const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    const results: Record<string, unknown>[] = []
    try {
      for (let ready = false; !ready; ) {
        if (proc.exitCode !== null) throw new Error(log.slice(-20).join('\n'))
        ready = await fetch(`${url}/health`).then(r => r.ok, () => false)
        if (!ready) await new Promise(r => setTimeout(r, 500))
      }
      const ask = async (label: string, system: string, user: string) => {
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 8 }),
        })
        const tm = ((await res.json()) as { timings: Record<string, number> }).timings
        const row = { label, promptTokens: tm.prompt_n + (tm.cache_n ?? 0), processed: tm.prompt_n, reused: tm.cache_n ?? 0, promptMs: Math.round(tm.prompt_ms) }
        results.push(row)
        console.log(`[prefix] ${JSON.stringify(row)}`)
      }
      // 1. Same slot, only the last user message differs: the ordinary within-step case.
      await ask('A first', shared, 'Task A: list the role names.')
      await ask('A again, other question', shared, 'Task B: which roles cannot edit files?')
      // 2. Shared head, different tail inside the system prompt: what agent roles would look like with a common head.
      await ask('shared head + role tail 1', `${shared}\n\nYou are ARCHITECT.`, 'Plan the change.')
      await ask('shared head + role tail 2', `${shared}\n\nYou are CODER.`, 'Implement the change.')
      // 3. Both slots taken by other work, then the shared prefix again: is it restored from the RAM prompt cache?
      await ask('unrelated 1', unrelated, 'Summarize.')
      await ask('unrelated 2', `${unrelated}\n\nother`, 'Summarize again.')
      await ask('unrelated 3 (third prompt)', `x ${unrelated}`, 'Summarize once more.')
      await ask('shared head after eviction', `${shared}\n\nYou are REVIEWER.`, 'Review the change.')
    } finally {
      proc.kill()
      fs.writeFileSync(path.join(outDir, `prefix-reuse${extra.length ? `-${extra.join('')}` : ''}.json`), JSON.stringify({ extra, results, serverLog: log.filter(l => /slot|cache|checkpoint|restor/i.test(l)).slice(-200) }, null, 2))
    }
    expect(results.length).toBe(8)
  }, 30 * 60_000)
})
