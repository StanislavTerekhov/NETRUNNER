// Live retrieval test with the real local models (llama.cpp) over this repository: embeddings only, hybrid
// (embeddings + word index) and hybrid + reranker, on the same index and the same 26 questions.
// Opt-in: NETRUNNER_LIVE=1 npx vitest run test/memory.live.test.ts --silent=false
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Database } from '../electron/main/services/db'
import { findRuntimeDir, LlamaRuntime, resolveRoles } from '../electron/main/services/llamacpp'
import { MemoryService, type SearchMode } from '../electron/main/services/memory'

const LIVE = process.env.NETRUNNER_LIVE === '1'
const root = path.resolve(import.meta.dirname, '..')
const home = path.join(os.homedir(), 'NETRUNNER')

const QUERIES: [string, RegExp][] = [
  ['how are paths outside the open workspace rejected', /electron\/main\/services\/(workspace|workspace-path)\.ts/],
  ['where is the network mode enforced for agent HTTP traffic', /electron\/main\/services\/(net-proxy|endpoint-policy)\.ts/],
  ['git checkpoint snapshot with a temporary index', /electron\/main\/services\/git\.ts/],
  ['which flags disable OpenCode auto update and models fetch', /electron\/main\/services\/opencode\.ts/],
  ['LoRA training script that measures eval loss before and after', /forge\/train_qlora\.py/],
  ['xterm terminal component', /src\/features\/terminal\/TerminalView\.tsx/],
  ['three-way merge of a worktree job into the workspace', /electron\/main\/services\/git\.ts/],
  ['run several agent jobs at the same time in lanes', /electron\/main\/services\/tasks\.ts/],
  ['read the metadata header of a GGUF file', /electron\/main\/services\/gguf\.ts/],
  ['find the LM Studio models folder', /electron\/main\/services\/lmstudio\.ts/],
  ['Content-Length framing of language server messages', /electron\/main\/services\/lsp\.ts/],
  ['bridge pyright to the parent message port in a utility process', /electron\/lsp-host\/pyright-host\.cjs|electron\/main\/index\.ts/],
  ['resumable model download from Hugging Face', /electron\/main\/services\/llamacpp\.ts/],
  ['install ripgrep from the GitHub release', /electron\/main\/services\/ripgrep\.ts/],
  ['Windows firewall rule that blocks opencode.exe', /electron\/main\/services\/firewall\.ts/],
  ['search chat history and export a conversation to Markdown', /electron\/main\/services\/conversations\.ts/],
  ['watch the workspace for files changed on disk', /electron\/main\/services\/workspace\.ts/],
  ['shrink an attached picture to JPEG before sending it', /src\/lib\/image\.ts/],
  ['Markdown links that only allow https', /src\/components\/Markdown\.tsx/],
  ['list of commands in the command palette', /src\/app\/commands\.ts/],
  ['built-in workspace layout presets', /src\/app\/layout-store\.ts/],
  ['teacher model writes question and answer pairs for the dataset', /forge\/build_dataset\.py/],
  ['GPU utilization and temperature from nvidia-smi', /electron\/main\/services\/(telemetry|hardware)\.ts/],
  ['tokens per second of agent tasks from llama-server counters', /electron\/main\/services\/(llamacpp|metrics)\.ts|electron\/main\/index\.ts/],
  ['validate saved layouts in the settings file', /electron\/main\/services\/settings\.ts/],
  ['где переводы интерфейса на русский', /src\/lib\/i18n(-ru)?\.ts/],
]

const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
})
afterAll(() => runtime.stopAll())

describe.skipIf(!LIVE)('memory retrieval (live, llama.cpp)', () => {
  it('ranks the right file: embeddings vs hybrid vs hybrid + reranker', async () => {
    // NETRUNNER_EMBED_MODEL=<model id> compares another embedding model on the same 26 questions.
    const roles = resolveRoles(await runtime.catalog.list(), { defaultModel: null, agentModel: null, embeddingModel: process.env.NETRUNNER_EMBED_MODEL ?? null })
    expect(roles.embedding).toBeTruthy()
    console.log(`[models] embedding ${roles.embedding}, reranker ${roles.reranker}`)
    const store = new Database(':memory:', path.join(root, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'))
    const memory = new MemoryService(
      store,
      (m, i) => runtime.embed(m, i),
      () => roles.embedding!,
      async (q, docs) => (roles.reranker ? runtime.rerank(roles.reranker, q, docs) : null),
    )
    const p = await memory.index(root)
    console.log(`[index] ${p.filesDone} files, ${p.chunksEmbedded} chunks in ${p.seconds.toFixed(0)} s`)
    expect(p.phase).toBe('done')

    const results: Record<SearchMode, { top1: number; top3: number; ms: number }> = { vector: { top1: 0, top3: 0, ms: 0 }, hybrid: { top1: 0, top3: 0, ms: 0 }, rerank: { top1: 0, top3: 0, ms: 0 } }
    for (const [q, expected] of QUERIES) {
      const line: string[] = []
      for (const mode of ['vector', 'hybrid', 'rerank'] as SearchMode[]) {
        const t0 = Date.now()
        const hits = await memory.search(root, q, 3, mode)
        results[mode].ms += Date.now() - t0
        const rank = hits.findIndex(h => expected.test(h.path))
        if (rank === 0) results[mode].top1++
        if (rank >= 0) results[mode].top3++
        line.push(`${mode}:${rank >= 0 ? rank + 1 : '-'}`)
      }
      console.log(`[query] ${line.join(' ')}  "${q}"`)
    }
    for (const [mode, r] of Object.entries(results)) {
      console.log(`[summary] ${mode}: top-1 ${r.top1}/${QUERIES.length}, top-3 ${r.top3}/${QUERIES.length}, ${(r.ms / QUERIES.length).toFixed(0)} ms/query`)
    }
    // Measured, not assumed: every mode must keep the right file in the top 3; the top-1 numbers are reported above.
    for (const r of Object.values(results)) expect(r.top3).toBeGreaterThanOrEqual(QUERIES.length - 1)
  }, 30 * 60_000)
})
