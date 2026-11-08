// NSC stage 5: an agent-like loop on Coder-Next, to compare llama-server setups in minutes instead of a whole smoke
// run. The real agent system prompt and tools (captured in stage 1), then turns that each add a tool result of
// 120–1300 tokens of code and generate up to 160 tokens — what agent steps do. NSC_CONFIGS picks configurations.
//   NETRUNNER_LIVE=1 [NSC_CONFIGS=…] npx vitest run test/nsc/stage5-agent-loop.live.test.ts --silent=false
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime, serverArgs } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage5')
const root = path.resolve(import.meta.dirname, '..', '..')
const official = findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')) ?? ''
const fork = path.join(home, 'fork', 'build-fork', 'bin')
const runtime = new LlamaRuntime({ binaryDir: () => official, modelsDir: path.join(home, 'models'), getMode: () => 'strict-offline', onDownload: () => undefined })

const CACHE = ['--cpu-moe', '--moe-cache-mib', '6144', '-lm', 'none']
const TOP8 = ['--override-kv', 'qwen3next.expert_used_count=int:8']
const ALL: { id: string; bin: string; extra: string[]; env?: Record<string, string> }[] = [
  { id: 'now', bin: official, extra: [] },
  { id: 'cache pinned', bin: official, extra: CACHE },
  { id: 'cache pinned cpu256', bin: official, extra: CACHE, env: { GGML_OP_OFFLOAD_MIN_BATCH: '256' } },
  { id: 'cache pinned cpu2048', bin: official, extra: CACHE, env: { GGML_OP_OFFLOAD_MIN_BATCH: '2048' } },
  { id: 'now cpu256', bin: official, extra: [], env: { GGML_OP_OFFLOAD_MIN_BATCH: '256' } },
  { id: 'now cpu2048', bin: official, extra: [], env: { GGML_OP_OFFLOAD_MIN_BATCH: '2048' } },
  { id: 'now top8', bin: official, extra: TOP8 },
  { id: 'cache pinned top8', bin: official, extra: [...CACHE, ...TOP8] },
  { id: 'fork cache pinned', bin: fork, extra: CACHE, env: { LLAMA_MOE_CACHE_STATS: '32' } },
  { id: 'fork cache pinned + hot set', bin: fork, extra: CACHE, env: { LLAMA_MOE_CACHE_STATS: '32', LLAMA_MOE_CACHE_PIN: path.join(outDir, 'pin.txt') } },
]
const only = process.env.NSC_CONFIGS?.split(',')
const CONFIGS = ALL.filter(c => !only || only.includes(c.id))

type Msg = { role: string; content: string }
const captured = JSON.parse(fs.readFileSync(path.join(home, 'nsc', 'stage1', 'captured-requests.json'), 'utf8')) as { messages: Msg[]; tools: unknown[] }[]
const base = captured[1] ?? captured[0]
// Tool results: slices of NETRUNNER's own code, ~3.5 characters per token.
const source = ['electron/main/services/opencode.ts', 'electron/main/services/llamacpp.ts', 'electron/main/services/tasks.ts'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n')
const TURNS = [120, 400, 1300, 200, 800, 150]

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 5: agent-like loop', () => {
  it('runs the loop on each configuration', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const entry = (await runtime.catalog.list()).find(e => e.id.includes('Qwen3-Coder-Next-Q4_K_M-00001'))
    if (!entry) throw new Error('Coder-Next not found')
    const file = path.join(outDir, only ? `loop-${only.map(s => s.replace(/\W+/g, '_')).join('-')}.json` : 'loop.json')
    const report: Record<string, unknown> = {}
    for (const c of CONFIGS) {
      const key = crypto.randomBytes(16).toString('hex')
      const port = 18097
      const url = `http://127.0.0.1:${port}`
      const log: string[] = []
      const proc = spawn(path.join(c.bin, 'llama-server.exe'), [...serverArgs(entry, port, key, 65536, 2), ...c.extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: c.bin, env: { ...process.env, ...c.env } })
      const onData = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean))
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      try {
        const t0 = Date.now()
        for (let ready = false; !ready; ) {
          if (proc.exitCode !== null) throw new Error(log.slice(-15).join('\n'))
          ready = await fetch(`${url}/health`).then(r => r.ok, () => false)
          if (!ready) await new Promise(r => setTimeout(r, 500))
        }
        const loadMs = Date.now() - t0
        const ask = async (messages: Msg[], max: number) => {
          const res = await fetch(`${url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ messages, tools: base.tools, temperature: 0, max_tokens: max }),
          })
          const j = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: unknown[] } }[]; timings: Record<string, number> }
          const m = j.choices[0].message
          return { text: m.content || JSON.stringify(m.tool_calls ?? ''), tm: j.timings }
        }
        await ask([{ role: 'user', content: 'Say OK.' }], 4) // warm-up
        const messages: Msg[] = [...base.messages]
        const turns: { prompt: number; promptMs: number; gen: number; genTokPerS: number }[] = []
        const t1 = Date.now()
        let at = 0
        for (const n of TURNS) {
          const r = await ask(messages, 160)
          turns.push({ prompt: r.tm.prompt_n, promptMs: Math.round(r.tm.prompt_ms), gen: r.tm.predicted_n, genTokPerS: Math.round(r.tm.predicted_per_second * 10) / 10 })
          const chunk = source.slice(at, at + Math.round(n * 3.5))
          at += chunk.length
          messages.push({ role: 'assistant', content: r.text.slice(0, 2000) }, { role: 'user', content: `Tool result (read):\n${chunk}\n\nContinue the task.` })
        }
        const totalMs = Date.now() - t1
        const sum = (k: 'promptMs' | 'gen') => turns.reduce((a, t) => a + t[k], 0)
        const genMs = turns.reduce((a, t) => a + (t.gen / t.genTokPerS) * 1000, 0)
        const row = {
          loadMs,
          totalS: Math.round(totalMs / 100) / 10,
          promptS: Math.round(sum('promptMs') / 100) / 10,
          genTokPerS: Math.round((sum('gen') / genMs) * 10000) / 10,
          turns: turns.map(t => `${t.prompt}p ${t.promptMs}ms / ${t.gen}g ${t.genTokPerS}`).join(' | '),
          cacheLog: log.filter(l => /moe_cache/.test(l)).slice(-30),
        }
        report[c.id] = row
        console.log(`[loop] ${c.id}: ${JSON.stringify({ ...row, cacheLog: undefined })}`)
      } catch (err) {
        report[c.id] = { error: String(err).slice(0, 1500) }
        console.log(`[loop] ${c.id}: FAILED ${String(err).slice(0, 400)}`)
      } finally {
        if (proc.exitCode === null) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        await new Promise(r => setTimeout(r, 8000))
        fs.writeFileSync(file, JSON.stringify(report, null, 2))
      }
    }
    expect(Object.keys(report)).toHaveLength(CONFIGS.length)
  }, 3 * 60 * 60_000)
})
