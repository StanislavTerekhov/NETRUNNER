import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInferenceEndpoint, assertOnlineAllowed, EndpointPolicyError } from '../electron/main/services/endpoint-policy'
import { readNdjson } from '../electron/main/services/ndjson'
import { ThinkLeakFilter } from '../electron/main/services/think-filter'
import { parseNvidiaSmi } from '../electron/main/services/hardware'
import {
  defaultContext,
  displayName,
  groupGgufFiles,
  metricsFromTimings,
  readSse,
  resolveRoles,
  selectRepoFiles,
  serverArgs,
  type CatalogEntry,
} from '../electron/main/services/llamacpp'
import { pickRuntimeAssets } from '../electron/main/services/runtime-install'
import { ConversationStore } from '../electron/main/services/conversations'
import { Database } from '../electron/main/services/db'
import { estimateFit, formatBytes } from '../src/lib/fit'

const GB = 1024 ** 3

describe('inference endpoint policy', () => {
  it.each(['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://127.5.5.5:1234'])(
    'allows loopback %s in every mode',
    url => {
      for (const mode of ['strict-offline', 'local-network', 'online-tools'] as const) {
        expect(() => assertInferenceEndpoint(url, mode)).not.toThrow()
      }
    },
  )

  it('allows private LAN only outside strict offline', () => {
    for (const url of ['http://192.168.1.20:11434', 'http://10.0.0.5:8080', 'http://172.20.1.1:1234', 'http://box.local:11434']) {
      expect(() => assertInferenceEndpoint(url, 'strict-offline')).toThrow(EndpointPolicyError)
      expect(() => assertInferenceEndpoint(url, 'local-network')).not.toThrow()
    }
  })

  it.each([
    'https://api.openai.com/v1',
    'http://8.8.8.8:11434',
    'http://ollama.example.com',
    'http://172.32.0.1',
    'http://localhost.evil.com',
    'ftp://127.0.0.1',
    'not a url',
  ])('never allows %s, even in online mode', url => {
    expect(() => assertInferenceEndpoint(url, 'online-tools')).toThrow(EndpointPolicyError)
  })

  it('downloads need ONLINE TOOLS', () => {
    expect(() => assertOnlineAllowed('strict-offline', 'Model download')).toThrow(/ONLINE TOOLS/)
    expect(() => assertOnlineAllowed('local-network', 'Model download')).toThrow(/ONLINE TOOLS/)
    expect(() => assertOnlineAllowed('online-tools', 'Model download')).not.toThrow()
  })
})

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  id: 'x.gguf', source: 'netrunner', name: 'x', files: ['C:\\m\\x.gguf'], sizeBytes: 1, modifiedAt: '', kind: 'chat', arch: 'qwen3', sizeLabel: null, quant: null,
  contextLength: 262144, expertCount: null, mmproj: null, capabilities: ['completion'], license: null, mtp: false, blocks: 32, ...over,
})

describe('llama.cpp catalog helpers', () => {
  it('groups split GGUF parts, attaches mmproj and skips incomplete downloads', () => {
    const p = (...s: string[]) => path.join('C:\\models', ...s)
    const groups = groupGgufFiles([
      p('Qwen', 'Coder', 'Qwen3-Coder-Next-Q4_K_M', 'Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf'),
      p('Qwen', 'Coder', 'Qwen3-Coder-Next-Q4_K_M', 'Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf'),
      p('Qwen', 'Coder', 'Qwen3-Coder-Next-Q4_K_M', 'Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf'),
      p('Qwen', 'Coder', 'Qwen3-Coder-Next-Q4_K_M', 'Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf'),
      p('unsloth', '27B', 'Qwen3.8-27B-UD-Q4_K_M.gguf'),
      p('unsloth', '27B', 'mmproj-F16.gguf'),
      p('partial', 'Big-Q8_0-00001-of-00003.gguf'),
    ])
    expect(groups.map(g => [path.basename(g.main), g.parts.length, g.mmproj && path.basename(g.mmproj)])).toEqual([
      ['Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf', 4, null],
      ['Qwen3.8-27B-UD-Q4_K_M.gguf', 1, 'mmproj-F16.gguf'],
    ])
    expect(displayName(groups[0].main)).toBe('Qwen3-Coder-Next-Q4_K_M')
  })

  it('selects one quantisation (folder or file name) plus the best projector from a HF tree', () => {
    const tree = [
      { type: 'directory', path: 'Qwen3-Coder-Next-Q4_K_M', size: 0 },
      { type: 'file', path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00002.gguf', size: 10 },
      { type: 'file', path: 'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00002-of-00002.gguf', size: 5 },
      { type: 'file', path: 'Qwen3-Coder-Next-Q5_K_M/Qwen3-Coder-Next-Q5_K_M-00001-of-00001.gguf', size: 12 },
      { type: 'file', path: 'Qwen3.8-27B-UD-Q4_K_M.gguf', size: 16 },
      { type: 'file', path: 'Qwen3.8-27B-UD-Q4_K_XL.gguf', size: 17 },
      { type: 'file', path: 'mmproj-BF16.gguf', size: 2 },
      { type: 'file', path: 'mmproj-F16.gguf', size: 1 },
      { type: 'file', path: 'README.md', size: 1 },
    ]
    expect(selectRepoFiles(tree, 'Q4_K_M').map(f => f.path)).toEqual([
      'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00002.gguf',
      'Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00002-of-00002.gguf',
      'mmproj-F16.gguf',
    ])
    expect(selectRepoFiles(tree, 'UD-Q4_K_M').map(f => f.path)).toEqual(['Qwen3.8-27B-UD-Q4_K_M.gguf', 'mmproj-F16.gguf'])
    expect(selectRepoFiles(tree, 'Q2_K')).toEqual([])
  })

  it('resolves model roles: explicit settings first, then the NETRUNNER preferences', () => {
    const list = [
      entry({ id: 'a/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf', name: 'Qwen3-Coder-Next-Q4_K_M', expertCount: 512, capabilities: ['completion', 'tools'] }),
      entry({ id: 'b/Qwen3.8-27B-UD-Q4_K_M.gguf', name: 'Qwen3.8-27B-UD-Q4_K_M', capabilities: ['completion', 'tools', 'thinking', 'vision'] }),
      entry({ id: 'c/Qwen3-Embedding-0.6B-Q8_0.gguf', name: 'Qwen3-Embedding-0.6B-Q8_0', kind: 'embedding', capabilities: ['embedding'] }),
    ]
    expect(resolveRoles(list, { defaultModel: null, agentModel: null, embeddingModel: null })).toEqual({
      general: 'b/Qwen3.8-27B-UD-Q4_K_M.gguf',
      agent: 'a/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf',
      embedding: 'c/Qwen3-Embedding-0.6B-Q8_0.gguf',
      reranker: null,
    })
    expect(resolveRoles(list, { defaultModel: 'a/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf', agentModel: 'gone.gguf', embeddingModel: null }).general).toBe(
      'a/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf',
    )
    expect(resolveRoles([], { defaultModel: null, agentModel: null, embeddingModel: null })).toEqual({ general: null, agent: null, embedding: null, reranker: null })
  })

  it('builds llama-server arguments per model kind and picks sensible context sizes', () => {
    const moe = entry({ expertCount: 512, mmproj: null })
    const dense = entry({ mmproj: 'C:\\m\\mmproj-F16.gguf' })
    const emb = entry({ kind: 'embedding', contextLength: 32768 })
    expect(defaultContext(moe)).toBe(65536)
    // Dense chat models default to 16K: a longer KV cache pushes 27B layers off a 12 GB GPU (measured).
    expect(defaultContext(dense)).toBe(16384)
    expect(defaultContext(emb)).toBe(8192)
    const a = serverArgs(dense, 1234, 'key', 16384)
    expect(a).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--api-key', 'key', '--no-webui', '--fit', 'on', '--jinja', '--mmproj', 'C:\\m\\mmproj-F16.gguf', '--no-mmproj-offload']))
    // q8 KV cache for chat models; MTP only when asked (useMtp decides).
    expect(a.join(' ')).toContain('-ctk q8_0 -ctv q8_0')
    expect(a).not.toContain('--spec-type')
    expect(serverArgs(dense, 1, 'k', 16384, 1, { mtp: true }).join(' ')).toContain('--spec-type draft-mtp')
    // MoE models get a quarter of the logical CPUs (memory-bound experts); dense ones keep llama.cpp's default.
    const m = serverArgs(moe, 1, 'k', 65536)
    expect(Number(m[m.indexOf('-t') + 1])).toBe(Math.max(4, Math.floor(os.availableParallelism() / 4)))
    expect(m[m.indexOf('-tb') + 1]).toBe(m[m.indexOf('-t') + 1])
    expect(a).not.toContain('-t')
    const rer = entry({ kind: 'reranker' })
    expect(serverArgs(rer, 1, 'k', 8192)).toEqual(expect.arrayContaining(['--reranking', '--pooling', 'rank']))
    expect(a[a.indexOf('--host') + 1]).toBe('127.0.0.1')
    expect(serverArgs(emb, 1, 'k', 8192)).toEqual(expect.arrayContaining(['--embedding', '--pooling', 'last']))
    expect(serverArgs(emb, 1, 'k', 8192)).not.toContain('--jinja')
  })
})

describe('llama-server streaming', () => {
  it('parses SSE chunks split anywhere and stops at [DONE]', async () => {
    const enc = new TextEncoder()
    const parts = ['data: {"a":1}\n', '\ndata: {"b"', ':2}\r\n\r\n', 'data: [DONE]\n\ndata: {"c":3}\n\n']
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close() } })
    const out: unknown[] = []
    for await (const ev of readSse(stream)) out.push(ev)
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('maps llama-server timings to chat metrics', () => {
    const m = metricsFromTimings({ prompt_n: 23, prompt_ms: 1223.9, predicted_n: 100, predicted_ms: 34215, predicted_per_second: 2.89 }, 9700, 45000)
    expect(m).toEqual({ promptTokens: 23, outputTokens: 100, promptMs: 1223.9, evalMs: 34215, loadMs: 9700, totalMs: 45000, tokensPerSecond: 2.89 })
    expect(metricsFromTimings(undefined, 0, 1).tokensPerSecond).toBe(0)
  })
})

describe('runtime installer', () => {
  const a = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1 })
  const assets = ['llama-b9-bin-win-cpu-x64.zip', 'llama-b9-bin-win-cuda-12.4-x64.zip', 'llama-b9-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip', 'llama-b9-bin-win-cuda-13.4-arm64.zip'].map(a)
  it('picks the newest CUDA x64 build with its CUDA runtime, or the CPU build', () => {
    expect(pickRuntimeAssets('b9', assets, true).map(x => x.name)).toEqual(['llama-b9-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip'])
    expect(pickRuntimeAssets('b9', assets, false).map(x => x.name)).toEqual(['llama-b9-bin-win-cpu-x64.zip'])
  })
})

describe('ThinkLeakFilter', () => {
  const run = (chunks: string[]) => {
    const f = new ThinkLeakFilter()
    return chunks.map(c => f.push(c)).join('') + f.end()
  }
  it('strips a leaked closing tag split across chunks', () => {
    expect(run(['</', 'think', '>\n\n', 'NETRUNNER', ' ONLINE'])).toBe('NETRUNNER ONLINE')
  })
  it('strips an empty think block', () => {
    expect(run(['<think>\n\n</think>\n\nHello'])).toBe('Hello')
    expect(run(['<think>', '\n\n', '</thi', 'nk>', 'Hi'])).toBe('Hi')
  })
  it('leaves normal answers and later tags untouched', () => {
    expect(run(['Use ', 'the </think> tag'])).toBe('Use the </think> tag')
    expect(run(['<div>', 'x'])).toBe('<div>x')
    expect(run(['<'])).toBe('<')
  })
})

describe('readNdjson', () => {
  it('reassembles objects split across chunks', async () => {
    const enc = new TextEncoder()
    const parts = ['{"a":1}\n{"b"', ':2}\n\n{"c":"ü', 'ber"}']
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p))
        c.close()
      },
    })
    const out: unknown[] = []
    for await (const o of readNdjson(stream)) out.push(o)
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 'über' }])
  })
})

describe('parseNvidiaSmi', () => {
  it('parses csv rows into bytes', () => {
    const [g] = parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288, 1024, 7, 621.01\r\n')
    expect(g).toEqual({ name: 'NVIDIA GeForce RTX 3060', vramTotalBytes: 12 * GB, vramUsedBytes: GB, utilizationPct: 7, driver: '621.01' })
  })
  it('keeps unknown utilization as null', () => {
    expect(parseNvidiaSmi('GPU, 8192, 0, [N/A], 1')[0].utilizationPct).toBeNull()
  })
})

describe('estimateFit', () => {
  const vram = 12 * GB
  const ram = 64 * GB
  it('classifies placement', () => {
    expect(estimateFit(5.2 * GB, vram, ram).kind).toBe('gpu')
    const hybrid = estimateFit(23 * GB, vram, ram)
    expect(hybrid.kind).toBe('hybrid')
    expect(hybrid.gpuShare).toBeGreaterThan(0.4)
    expect(hybrid.gpuShare).toBeLessThan(0.5)
    expect(estimateFit(290 * GB, vram, ram).kind).toBe('too-large')
    expect(estimateFit(5 * GB, 0, ram)).toMatchObject({ kind: 'hybrid', gpuShare: 0 })
  })
  it('formats bytes', () => {
    expect(formatBytes(23 * GB)).toBe('23.0 GB')
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('ConversationStore (SQLite)', () => {
  const vec = path.resolve(import.meta.dirname, '..', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')

  it('saves, lists newest first, updates in place and rejects path-like ids', () => {
    const store = new ConversationStore(new Database(':memory:', vec))
    const base = { model: 'm', createdAt: '2026-01-01', systemPrompt: '', messages: [{ role: 'user' as const, content: 'hi' }] }
    store.save({ ...base, id: 'a', title: 'A', updatedAt: '2026-01-01T00:00:00Z' })
    store.save({ ...base, id: 'b', title: 'B', updatedAt: '2026-01-02T00:00:00Z' })
    expect(store.list().map(c => [c.id, c.messageCount])).toEqual([['b', 1], ['a', 1]])
    store.save({ ...base, id: 'a', title: 'A2', updatedAt: '2026-01-03T00:00:00Z', messages: [...base.messages, { role: 'assistant', content: 'yo' }] })
    expect(store.list()[0]).toMatchObject({ id: 'a', title: 'A2', messageCount: 2 })
    expect(store.get('a').messages[1].content).toBe('yo')
    expect(() => store.get('../settings')).toThrow(/Invalid conversation id/)
    store.remove('a')
    expect(store.list().map(c => c.id)).toEqual(['b'])
  })

  it('imports phase-2 JSON files once and keeps them as a backup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-conv-'))
    const json = path.join(dir, 'conversations')
    await fs.mkdir(json)
    const c = { id: 'x1', title: 'Old', model: 'm', createdAt: 't', updatedAt: 't', systemPrompt: 's', messages: [{ role: 'user', content: 'q' }] }
    await fs.writeFile(path.join(json, 'x1.json'), JSON.stringify(c))
    await fs.writeFile(path.join(json, 'broken.json'), '{nope')
    const store = new ConversationStore(new Database(':memory:', vec))
    expect(await store.importJsonDir(json)).toBe(1)
    expect(store.get('x1').title).toBe('Old')
    expect(await store.importJsonDir(json)).toBe(0) // folder was renamed
    expect((await fs.readdir(dir)).some(n => n.startsWith('conversations.imported-'))).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
