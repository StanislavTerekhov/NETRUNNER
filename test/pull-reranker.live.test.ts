// One-off download of the reranker model through NETRUNNER's own Hugging Face downloader (ONLINE TOOLS).
// Opt-in: NETRUNNER_PULL=1 npx vitest run test/pull-reranker.live.test.ts
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRuntimeDir, LlamaRuntime } from '../electron/main/services/llamacpp'
import { RECOMMENDED } from '../electron/main/services/setup'

describe.skipIf(process.env.NETRUNNER_PULL !== '1')('reranker download', () => {
  it(
    'downloads the recommended reranker GGUF',
    async () => {
      const home = path.join(os.homedir(), 'NETRUNNER')
      const runtime = new LlamaRuntime({
        binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
        modelsDir: path.join(home, 'models'),
        getMode: () => 'online-tools',
        onDownload: (host, detail) => console.log(`[net] ${host} ${detail}`),
      })
      const done = await new Promise<{ error: string | null }>(resolve => runtime.startPull(RECOMMENDED.reranker, p => p.done && resolve(p)))
      expect(done.error).toBeNull()
      const rer = (await runtime.catalog.list()).find(e => e.kind === 'reranker')
      console.log(`[pull] reranker: ${rer?.id} ${rer?.sizeBytes}`)
      expect(rer).toBeTruthy()
    },
    20 * 60_000,
  )
})
