// NSC stage 1, check 3: pipeline steps with the shared prompt head (all roles: same system text and tools). Without
// help llama-server keeps a checkpoint of a hybrid model only one batch before the end of a prompt, so the next step
// cannot fall back to the end of the shared head. A "priming" request (shared head + an empty task) puts a checkpoint
// right there. Uses the requests OpenCode really sends (stage1-capture.live.test.ts) and Coder-Next.
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage1-prime.live.test.ts --silent=false
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
// Verified facts of a pipeline step (diff + command output) are a few thousand tokens; real code stands in for them.
const facts = (file: string) => fs.readFileSync(path.join(root, 'electron', 'main', 'services', file), 'utf8').slice(0, 6000)
const STEPS = [
  { role: 'ARCHITECT', facts: facts('tasks.ts') },
  { role: 'CODER', facts: facts('memory.ts') },
  { role: 'DEBUGGER', facts: facts('git.ts') },
  { role: 'REVIEWER', facts: facts('workspace.ts') },
]

type Body = { messages: { role: string; content: unknown }[]; tools?: unknown[] }

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 1: priming the shared head', () => {
  it('measures the first request of every pipeline step with and without priming', async () => {
    if (!binDir) throw new Error('llama.cpp runtime not found')
    const captured = JSON.parse(fs.readFileSync(path.join(outDir, 'captured-requests.json'), 'utf8')) as Body[]
    const head = captured.find(b => b.tools?.length)
    if (!head) throw new Error('run stage1-capture first')
    const system = head.messages.filter(m => m.role === 'system')
    const entry = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    if (!entry) throw new Error('Coder-Next not found')
    const results: Record<string, unknown>[] = []
    for (const prime of [false, true]) {
      const key = crypto.randomBytes(16).toString('hex')
      const port = 18092
      const url = `http://127.0.0.1:${port}`
      const log: string[] = []
      const proc = spawn(path.join(binDir, 'llama-server.exe'), serverArgs(entry, port, key, 65536, 2), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: binDir })
      const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      try {
        for (let ready = false; !ready; ) {
          if (proc.exitCode !== null) throw new Error(log.slice(-20).join('\n'))
          ready = await fetch(`${url}/health`).then(r => r.ok, () => false)
          if (!ready) await new Promise(r => setTimeout(r, 500))
        }
        const ask = async (label: string, user: string, maxTokens: number) => {
          const res = await fetch(`${url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ messages: [...system, { role: 'user', content: user }], tools: head.tools, temperature: 0, max_tokens: maxTokens }),
          })
          const tm = ((await res.json()) as { timings: Record<string, number> }).timings
          const row = { prime, label, promptTokens: tm.prompt_n + (tm.cache_n ?? 0), processed: tm.prompt_n, reused: tm.cache_n ?? 0, promptMs: Math.round(tm.prompt_ms) }
          results.push(row)
          console.log(`[prime] ${JSON.stringify(row)}`)
        }
        if (prime) await ask('priming: shared head only', '[ROLE:', 1)
        for (const s of STEPS) {
          await ask(`${s.role} step, first request`, `[ROLE: ${s.role}] Do the step.\n\nGoal: add a check for an empty cart.\n\n### Verified facts\n${s.facts}`, 48)
          // Something else (chat, another lane) uses the server between steps.
          await ask(`${s.role} step, follow-up`, `[ROLE: ${s.role}] Do the step.\n\nGoal: add a check for an empty cart.\n\n### Verified facts\n${s.facts}\n\nContinue.`, 16)
        }
      } finally {
        proc.kill()
        await new Promise(r => setTimeout(r, 4000))
      }
    }
    fs.writeFileSync(path.join(outDir, 'prime.json'), JSON.stringify(results, null, 2))
    expect(results.length).toBeGreaterThan(0)
  }, 60 * 60_000)
})
