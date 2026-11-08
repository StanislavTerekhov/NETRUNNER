// Phase 10 (1.4.0): speed and quality of the local AI — fit plan, MTP choice, hybrid memory search, verified facts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPart, AgentTask } from '../electron/shared/ipc'
import { readGguf } from '../electron/main/services/gguf'
import { defaultContext, parseFitPlan, serverArgs, useMtp, type CatalogEntry } from '../electron/main/services/llamacpp'
import { demoteTests, ftsQuery, fuseRankings, wordsFor } from '../electron/main/services/memory'
import { formatVerifiedFacts } from '../electron/main/services/tasks'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** GGUF v3 with string metadata and tensor infos (name, 1 dim, f32) but no tensor data. */
function writeGguf(file: string, meta: Record<string, string>, tensors: string[]): void {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const u64 = (n: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(n))
    return b
  }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  const parts = [Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(Object.keys(meta).length)]
  for (const [k, v] of Object.entries(meta)) parts.push(str(k), u32(8), str(v))
  tensors.forEach((t, i) => parts.push(str(t), u32(1), u64(16), u32(0), u64(i * 64)))
  fs.writeFileSync(file, Buffer.concat(parts))
}

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  id: 'x.gguf', source: 'netrunner', name: 'x', files: ['C:\\m\\x.gguf'], sizeBytes: 1, modifiedAt: '', kind: 'chat', arch: 'qwen35', sizeLabel: null, quant: null,
  contextLength: 262144, expertCount: null, mmproj: null, capabilities: ['completion'], license: null, mtp: false, blocks: 64, ...over,
})

describe('GGUF tensor names', () => {
  it('counts tensors by name fragment, so an MTP key without MTP weights is caught', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-gguf-'))
    temps.push(dir)
    const file = path.join(dir, 'm.gguf')
    writeGguf(file, { 'general.architecture': 'qwen35' }, ['blk.0.attn_q.weight', 'blk.32.nextn.eh_proj.weight', 'blk.32.nextn.enorm.weight'])
    const { meta, tensorCounts } = await readGguf(file, 1 << 20, ['nextn', 'mmproj'])
    expect(meta.get('general.architecture')).toBe('qwen35')
    expect(tensorCounts).toEqual({ nextn: 2, mmproj: 0 })
  })
})

describe('runtime choices', () => {
  it('uses the MTP head only for a dense chat model larger than the GPU', () => {
    const gb = 1024 ** 3
    expect(useMtp(entry({ mtp: true, sizeBytes: 17 * gb }), 12 * gb)).toBe(true)
    expect(useMtp(entry({ mtp: true, sizeBytes: 11 * gb }), 12 * gb)).toBe(false)
    expect(useMtp(entry({ mtp: false, sizeBytes: 17 * gb }), 12 * gb)).toBe(false)
    expect(useMtp(entry({ mtp: true, sizeBytes: 17 * gb }), null)).toBe(false)
    expect(serverArgs(entry({ mtp: true }), 1, 'k', 16384, 1, { mtp: true })).toEqual(expect.arrayContaining(['--spec-type', 'draft-mtp']))
  })

  it('defaults to 16K for dense chat models, 64K for MoE and 8K for embedding/reranker models', () => {
    expect(defaultContext(entry({}))).toBe(16384)
    expect(defaultContext(entry({ expertCount: 512 }))).toBe(65536)
    expect(defaultContext(entry({ kind: 'reranker', contextLength: 40960 }))).toBe(8192)
    expect(defaultContext(entry({ contextLength: 4096 }))).toBe(4096)
  })

  it('reads the fit plan of llama-fit-params', () => {
    expect(parseFitPlan('-c 16384 -ngl -1', 64, 16384)).toEqual({ gpuLayers: 64, totalLayers: 64, cpuExpertLayers: 0, ctx: 16384 })
    const moe = parseFitPlan('-c 65536 -ngl -1 -ot "blk\\.30\\.ffn_up_exps=CPU,blk\\.30\\.ffn_down_exps=CPU,blk\\.31\\.ffn_gate_exps=CPU"', 48, 65536)
    expect(moe).toMatchObject({ gpuLayers: 48, cpuExpertLayers: 2 })
    expect(parseFitPlan('-c 16384 -ngl 41', 64, 16384)?.gpuLayers).toBe(41)
    expect(parseFitPlan('error: failed to load model', 64, 16384)).toBeNull()
  })
})

describe('hybrid memory search', () => {
  it('splits identifiers and paths so plain words match code names', () => {
    const w = wordsFor('electron/main/services/net-proxy.ts', 'export function resolveInWorkspace(p) { return net_proxy }')
    expect(w).toContain('resolve In Workspace')
    expect(w).toContain('electron main services net proxy ts')
  })

  it('builds an OR-ed prefix query without stop words, Russian included', () => {
    expect(ftsQuery('how is the readGguf header parsed')).toBe('"readgguf"* OR "read"* OR "gguf"* OR "header"* OR "parsed"*')
    expect(ftsQuery('где переводы интерфейса')).toBe('"где"* OR "переводы"* OR "интерфейса"*')
    expect(ftsQuery('a to of')).toBeNull()
  })

  it('fuses rankings by reciprocal rank: agreement beats a single first place', () => {
    expect(fuseRankings([[1, 2, 3], [2, 3, 1], [2, 1]])).toEqual([2, 1, 3])
  })

  it('moves tests below the implementation unless the question is about tests', () => {
    const hits = [{ path: 'test/git.test.ts' }, { path: 'electron/main/services/git.ts' }, { path: 'src/a.ts' }]
    expect(demoteTests(hits, 'git checkpoint').map(h => h.path)).toEqual(['electron/main/services/git.ts', 'src/a.ts', 'test/git.test.ts'])
    expect(demoteTests(hits, 'which tests cover git').map(h => h.path)[0]).toBe('test/git.test.ts')
    expect(demoteTests(hits, 'где тесты git').map(h => h.path)[0]).toBe('test/git.test.ts')
  })
})

describe('verified facts between pipeline steps', () => {
  const task = (step: number, status: AgentTask['status']): AgentTask => ({
    id: step, role: step === 0 ? 'architect' : 'coder', prompt: '', status, useMemory: false, pipelineId: 'p', pipelineStep: step, sessionId: null,
    checkpoint: null, result: null, error: null, createdAt: '', startedAt: null, finishedAt: null, jobId: 'p', worktree: null,
  })
  const tool = (t: string, input: Record<string, unknown>, output = '', error: string | null = null): AgentPart => ({
    kind: 'tool', id: Math.random().toString(), messageId: 'm', tool: t, status: error ? 'error' : 'completed', title: t, input, output, error,
  })

  it('lists the diff, the files each step touched and the real command output', () => {
    const text = formatVerifiedFacts('diff --git a/src/a.ts b/src/a.ts\n+const x = 1', [
      { task: task(0, 'done'), parts: [] },
      { task: task(1, 'done'), parts: [tool('edit', { filePath: 'src/a.ts' }), tool('bash', { command: 'npm test' }, '', 'FAIL test/a.test.ts\n1 failed')] },
    ])
    expect(text).toContain('```diff\ndiff --git a/src/a.ts')
    expect(text).toContain('### Step 1 (ARCHITECT), status done\nFiles it touched: none\nCommands it ran: none')
    expect(text).toContain('Files it touched: src/a.ts')
    expect(text).toContain('Command: `npm test` → error\n```\nFAIL test/a.test.ts\n1 failed\n```')
  })

  it('says so when nothing changed and cuts long facts', () => {
    expect(formatVerifiedFacts('', [])).toContain('No file has changed.')
    const long = formatVerifiedFacts('x'.repeat(5000), [], 1000)
    expect(long.length).toBeLessThan(1100)
    expect(long).toMatch(/facts cut at 1000 characters/)
  })
})
