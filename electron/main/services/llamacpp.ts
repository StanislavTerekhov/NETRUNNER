import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ChatChunk,
  ChatMetrics,
  ChatRequest,
  FitPlan,
  ModelDetails,
  ModelInfo,
  NetworkMode,
  PullProgress,
  RunningModel,
  RuntimeStatus,
} from '../../shared/ipc'
import type { LaunchProfile } from '../../shared/autotune'
import { assertOnlineAllowed } from './endpoint-policy'
import { metaNum, metaStr, readGguf } from './gguf'
import { freePort } from './opencode'
import { traffic } from './traffic'
import { ThinkLeakFilter } from './think-filter'

const run = promisify(execFile)

// ---------------------------------------------------------------------------------------------
// Catalog: GGUF files under the models directory
// ---------------------------------------------------------------------------------------------

export type ModelSource = 'netrunner' | 'lmstudio'

/** Another folder of GGUF models read in place (LM Studio); its ids carry the prefix. */
export interface ModelRoot {
  source: ModelSource
  dir: string
  prefix: string
}

export const LMSTUDIO_PREFIX = 'lmstudio:'

/** Tools the chat model may call (OpenAI function format) and the runner that executes them. */
export interface ChatTools {
  defs: readonly { name: string; description: string; parameters: unknown }[]
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
}

/** Search → read → read again is typical; a model stuck in a loop is cut off here. */
const MAX_TOOL_ROUNDS = 10

const TRIMMED = '\n[shortened to save context — call the tool again if you need the rest]'

/**
 * Tool results pile up in the prompt (pages, API JSON): before each round the oldest ones are shortened so the
 * request stays within the model's context (~3 characters per token, 60% of the window for the conversation,
 * the rest for the answer). `hard`: after the server still reported an overflow, every result is cut to a stub.
 */
export function fitToolResults(messages: Record<string, unknown>[], ctxTokens: number, hard = false): void {
  const size = () => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + JSON.stringify(m.tool_calls ?? '').length, 0)
  const budget = Math.floor(ctxTokens * 3 * 0.6)
  const tools = messages.filter(m => m.role === 'tool' && typeof m.content === 'string')
  // The newest result is what the model is about to read: shorten it last.
  for (const keep of hard ? [600] : [2000, 600]) {
    for (const m of tools.slice(0, hard ? tools.length : -1)) {
      if (!hard && size() <= budget) return
      const c = m.content as string
      if (c.length > keep + TRIMMED.length) m.content = c.slice(0, keep) + TRIMMED
    }
  }
  if (!hard && size() > budget && tools.length) {
    const last = tools[tools.length - 1]
    const c = last.content as string
    const room = Math.max(1500, c.length - (size() - budget))
    if (c.length > room + TRIMMED.length) last.content = c.slice(0, room) + TRIMMED
  }
}

export interface CatalogEntry {
  /** Stable id: path of the (first) GGUF file relative to its models folder, forward slashes, plus the folder's prefix. */
  id: string
  source: ModelSource
  name: string
  files: string[]
  sizeBytes: number
  modifiedAt: string
  kind: 'chat' | 'embedding' | 'reranker'
  arch: string | null
  sizeLabel: string | null
  quant: string | null
  contextLength: number | null
  expertCount: number | null
  /** MoE: experts used per token, as trained. */
  expertsUsed?: number | null
  mmproj: string | null
  capabilities: string[]
  license: string | null
  /** The file carries multi-token-prediction (nextn) weights usable for speculative decoding (`--spec-type draft-mtp`). */
  mtp: boolean
  /** Repeating layers (block_count). */
  blocks: number | null
}

const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i
const FILE_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L',
  14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS',
  23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
}

/** F16 projector (preferred: widest llama.cpp support), not BF16. */
const isF16 = (p: string) => /(^|[^b])f16/i.test(path.basename(p))

/** Display name from the file name: split suffix and extension removed. */
export function displayName(file: string): string {
  return path.basename(file).replace(SPLIT_RE, '').replace(/\.gguf$/i, '')
}

/** Group GGUF files into models: split parts belong together, mmproj files attach to a model in the same folder. */
export function groupGgufFiles(files: string[]): { main: string; parts: string[]; mmproj: string | null }[] {
  const byDir = new Map<string, string[]>()
  for (const f of files) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) ?? []), f])
  const out: { main: string; parts: string[]; mmproj: string | null }[] = []
  for (const [dir, list] of byDir) {
    const mmprojs = list.filter(f => /^mmproj/i.test(path.basename(f)))
    // A projector may sit one level up (e.g. repo root while quant parts live in a subfolder).
    const parentMmproj = files.filter(f => path.dirname(f) === path.dirname(dir) && /^mmproj/i.test(path.basename(f)))
    const mmproj = [...mmprojs, ...parentMmproj].sort((a, b) => (isF16(b) ? 1 : 0) - (isF16(a) ? 1 : 0))[0] ?? null
    const models = list.filter(f => !/^mmproj/i.test(path.basename(f)))
    const groups = new Map<string, string[]>()
    for (const f of models) {
      const key = f.replace(SPLIT_RE, '')
      groups.set(key, [...(groups.get(key) ?? []), f])
    }
    for (const parts of groups.values()) {
      parts.sort()
      const m = parts[0].match(SPLIT_RE)
      // Incomplete split downloads are not usable models.
      if (m && parts.length !== Number(m[2])) continue
      out.push({ main: parts[0], parts, mmproj })
    }
  }
  return out.sort((a, b) => a.main.localeCompare(b.main))
}

async function walkGguf(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && !e.name.startsWith('.')) out.push(...(await walkGguf(p)))
    else if (e.isFile() && /\.gguf$/i.test(e.name)) out.push(p)
  }
  return out
}

export class ModelCatalog {
  private cache = new Map<string, { key: string; entry: CatalogEntry }>()

  /** `extra` is resolved on every listing, so a folder chosen in the settings applies at once. */
  constructor(
    readonly dir: string,
    private readonly extra: () => ModelRoot[] = () => [],
  ) {}

  roots(): ModelRoot[] {
    const own: ModelRoot = { source: 'netrunner', dir: this.dir, prefix: '' }
    // The same folder must not be listed twice (e.g. LM Studio pointed at the NETRUNNER models folder).
    const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    return [own, ...this.extra().filter(r => !same(r.dir, this.dir))]
  }

  async list(): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = []
    for (const root of this.roots()) out.push(...(await this.listRoot(root)))
    return out
  }

  private async listRoot(root: ModelRoot): Promise<CatalogEntry[]> {
    const groups = groupGgufFiles(await walkGguf(root.dir))
    const entries: CatalogEntry[] = []
    for (const g of groups) {
      try {
        const stats = await Promise.all(g.parts.map(p => fsp.stat(p)))
        const key = `${stats.map(s => `${s.size}:${s.mtimeMs}`).join('|')}|${g.mmproj ?? ''}`
        const cached = this.cache.get(g.main)
        if (cached?.key === key) {
          entries.push(cached.entry)
          continue
        }
        const { meta, tensorCounts } = await readGguf(g.main, undefined, ['nextn'])
        const arch = metaStr(meta, 'general.architecture')
        const template = metaStr(meta, 'tokenizer.chat_template') ?? ''
        // pooling_type: 4 = rank (a reranker), any other = an embedding model.
        const pooling = arch !== null ? metaNum(meta, `${arch}.pooling_type`) : null
        const isReranker = pooling === 4
        const isEmbedding = pooling !== null && !isReranker
        const caps = isReranker
          ? ['rerank']
          : isEmbedding
          ? ['embedding']
          : ['completion', ...(/tools/.test(template) ? ['tools'] : []), ...(/enable_thinking|<think>/.test(template) ? ['thinking'] : []), ...(g.mmproj ? ['vision'] : [])]
        const fileType = metaNum(meta, 'general.file_type')
        const entry: CatalogEntry = {
          id: root.prefix + path.relative(root.dir, g.main).split(path.sep).join('/'),
          source: root.source,
          name: displayName(g.main),
          files: g.parts,
          sizeBytes: stats.reduce((a, s) => a + s.size, 0),
          modifiedAt: new Date(Math.max(...stats.map(s => s.mtimeMs))).toISOString(),
          kind: isReranker ? 'reranker' : isEmbedding ? 'embedding' : 'chat',
          arch,
          sizeLabel: metaStr(meta, 'general.size_label'),
          quant: (fileType !== null && FILE_TYPES[fileType]) || (displayName(g.main).match(/(UD-)?(I?Q\d[\w]*|BF16|F16|F32)$/i)?.[0] ?? null),
          contextLength: arch ? metaNum(meta, `${arch}.context_length`) : null,
          expertCount: arch ? metaNum(meta, `${arch}.expert_count`) : null,
          expertsUsed: arch ? metaNum(meta, `${arch}.expert_used_count`) : null,
          mmproj: g.mmproj,
          capabilities: caps,
          license: metaStr(meta, 'general.license'),
          // The key alone is not enough: an export can keep the key but lose the tensors (seen with merged LoRA models).
          mtp: (arch ? (metaNum(meta, `${arch}.nextn_predict_layers`) ?? 0) : 0) > 0 && tensorCounts.nextn > 0,
          blocks: arch ? metaNum(meta, `${arch}.block_count`) : null,
        }
        this.cache.set(g.main, { key, entry })
        entries.push(entry)
      } catch {
        /* unreadable or partial file: not listed */
      }
    }
    return entries
  }

  async get(id: string): Promise<CatalogEntry> {
    const e = (await this.list()).find(m => m.id === id)
    if (!e) throw new Error(`Model not found: ${id}`)
    return e
  }
}

/**
 * Which model plays which role. Explicit settings win; otherwise the configured NETRUNNER models are
 * preferred (Qwen3.8-27B general, Qwen3-Coder-Next for agents), then any suitable model.
 */
export function resolveRoles(
  entries: CatalogEntry[],
  settings: { defaultModel: string | null; agentModel: string | null; embeddingModel: string | null },
): { general: string | null; agent: string | null; embedding: string | null; reranker: string | null } {
  const has = (id: string | null) => (id && entries.some(e => e.id === id) ? id : null)
  const chat = entries.filter(e => e.kind === 'chat')
  const pick = (prefs: RegExp[], pool: CatalogEntry[]) => {
    for (const re of prefs) {
      const hit = pool.find(e => re.test(e.name))
      if (hit) return hit.id
    }
    return pool[0]?.id ?? null
  }
  return {
    // IQ3_XXS of the dense 27B fits a 12 GB GPU almost entirely: ~13 tok/s at 16K with a q8 KV cache (Q4_K_M + MTP ~8).
    general: has(settings.defaultModel) ?? pick([/qwen3\.8-27b.*iq3/i, /qwen3\.8-27b/i, /qwen3\.\d/i, /qwen/i], chat),
    agent: has(settings.agentModel) ?? pick([/coder-next/i, /coder/i], chat.filter(e => e.capabilities.includes('tools'))),
    embedding: has(settings.embeddingModel) ?? entries.find(e => e.kind === 'embedding')?.id ?? null,
    reranker: entries.find(e => e.kind === 'reranker')?.id ?? null,
  }
}

/** Newest llama.cpp build folder (`b<number>`) that contains llama-server. */
export function findRuntimeDir(root: string): string | null {
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^b\d+$/.test(d.name)).map(d => d.name)
    : []
  dirs.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
  for (const d of dirs) {
    if (fs.existsSync(path.join(root, d, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'))) return path.join(root, d)
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Runtime: llama-server processes
// ---------------------------------------------------------------------------------------------

export type Slot = 'chat' | 'embed' | 'rerank'

interface Server {
  slot: Slot
  modelId: string
  proc: ChildProcess
  url: string
  key: string
  /** Context of one sequence. */
  ctx: number
  /** Speculative decoding with the model's MTP head is on. */
  mtp: boolean
  /** Sequences served at the same time (llama-server slots). */
  parallel: number
  state: 'loading' | 'ready'
  startedAt: number
  readyMs: number | null
  /** GPU memory taken by this server: total used after load minus before (Windows WDDM has no per-process value). */
  vramBytes: number | null
  /** GPU memory in use by everything else when this server started loading (null without nvidia-smi). */
  gpuBeforeBytes: number | null
  log: string[]
}

let vramTotal: number | null | undefined
/** Total VRAM of the GPUs (cached; null without nvidia-smi). */
export async function gpuTotalBytes(): Promise<number | null> {
  if (vramTotal !== undefined) return vramTotal
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true })
    const mib = stdout.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isFinite(n))
    vramTotal = mib.length ? mib.reduce((a, b) => a + b, 0) * 1024 * 1024 : null
  } catch {
    vramTotal = null
  }
  return vramTotal
}

async function gpuUsedBytes(): Promise<number | null> {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true })
    const mib = stdout.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isFinite(n))
    return mib.length ? mib.reduce((a, b) => a + b, 0) * 1024 * 1024 : null
  } catch {
    return null
  }
}

/**
 * Default context per model: generous for MoE coding models (cheap KV), 16K for dense ones — on a 12 GB GPU the KV
 * cache of a longer context pushes layers of the dense 27B to the CPU (measured 8.1 tok/s at 32K, 12.8 at 16K with a
 * q8 cache). A longer context is still available per chat (the server restarts with it).
 */
export function defaultContext(e: CatalogEntry): number {
  const max = e.contextLength ?? 32768
  if (e.kind !== 'chat') return Math.min(max, 8192)
  return Math.min(max, (e.expertCount ?? 0) > 0 ? 65536 : 16384)
}

/**
 * Speculative decoding with the model's own MTP head pays off only when much of a dense model runs from system RAM:
 * Qwen3.8-27B Q4_K_M 3.5 → 8.7 tok/s, while the mostly-on-GPU IQ3_XXS gains nothing (and loses on Russian text).
 */
export function useMtp(e: CatalogEntry, vramBytes: number | null): boolean {
  return e.mtp && e.kind === 'chat' && vramBytes !== null && e.sizeBytes > vramBytes
}

/**
 * `ctx` is the context of one sequence; with `parallel` sequences (agents working at the same time) llama-server
 * splits `-c` between its slots, so the total is ctx × parallel.
 */
export function serverArgs(e: CatalogEntry, port: number, key: string, ctx: number, parallel = 1, opts: { mtp?: boolean; profile?: LaunchProfile | null; slotSavePath?: string } = {}): string[] {
  const np = Math.max(1, Math.floor(parallel))
  const args = ['-m', e.files[0], '--host', '127.0.0.1', '--port', String(port), '--api-key', key, '--no-webui', '-c', String(ctx * np), '-np', String(np)]
  // Let llama.cpp place layers / MoE experts to fit the GPU; -c is set, so only placement is adjusted.
  args.push('--fit', 'on', '-fa', 'auto')
  if (e.kind === 'embedding') args.push('--embedding', '--pooling', 'last')
  else if (e.kind === 'reranker') args.push('--reranking', '--pooling', 'rank')
  else {
    // q8 KV cache: half the VRAM of f16 for the same context, so more layers stay on the GPU (+20% on the 27B).
    args.push('-ctk', 'q8_0', '-ctv', 'q8_0')
    if (opts.mtp) args.push('--spec-type', 'draft-mtp')
    // --metrics: token counters at /metrics measure agent speed (OpenCode itself reports no timings).
    args.push('--jinja', '--reasoning-format', 'deepseek', '--metrics')
    // Large physical batches speed up prompt processing when MoE experts run on the CPU:
    // measured on Qwen3-Coder-Next, 12.5K-token prompt 120 → 328 tok/s with -ub 4096.
    const ub = (e.expertCount ?? 0) > 0 ? '4096' : '2048'
    args.push('-b', ub, '-ub', ub)
    // MoE experts on the CPU are memory-bound: a quarter of the logical CPUs beats llama.cpp's default (all physical
    // cores). Measured on Qwen3-Coder-Next, 5950X: 8 threads 21.3 tok/s at 21% CPU vs 16 threads 20.0 at 42%.
    if ((e.expertCount ?? 0) > 0) {
      const t = String(Math.max(4, Math.floor(os.availableParallelism() / 4)))
      args.push('-t', t, '-tb', t)
    }
    // A profile found by the autotuner (measured on this machine) replaces these defaults.
    const p = opts.profile
    if (p?.threads) setArg(args, ['-t', '-tb'], String(p.threads))
    if (p?.ubatch) setArg(args, ['-b', '-ub'], String(p.ubatch))
    // GPU expert cache over memory-mapped weights. Page-locked weights (-lm none) would make it faster (NSC stage 5,
    // Coder-Next with a 6 GB cache: 24.2 → 30.3 tok/s) but are deliberately not used (NSC-ME phase 5, operator's
    // decision): they take 76 of 77 GB of commit, Windows grows the pagefile to load them, other programs get ~7 GB,
    // and a return after an unload takes ~100 s. On mmap the weights stay reclaimable by Windows.
    // VRAM saver (NSC-ME phase 6): all experts in RAM, no cache — the cheapest way to give VRAM back (−9% generation).
    if (p?.cpuMoe && (e.expertCount ?? 0) > 0) args.push('--cpu-moe')
    else if (p?.moeCacheMib && (e.expertCount ?? 0) > 0) args.push('--cpu-moe', '--moe-cache-mib', String(p.moeCacheMib))
    // Fewer experts per token (NSC stage 6). Qwen3-Coder-Next 10 → 8: +19% generation, MMLU / GSM8K / HumanEval within noise.
    if (p?.expertsUsed && (e.expertCount ?? 0) > 0 && e.arch) args.push('--override-kv', `${e.arch}.expert_used_count=int:${p.expertsUsed}`)
    // The vision projector stays on the CPU: on the GPU it takes VRAM from the language layers (27B text 13.1 → 9.1
    // tok/s), while on the CPU a picture still encodes in about a second.
    if (e.mmproj) args.push('--mmproj', e.mmproj, '--no-mmproj-offload')
    // Conversation state can be saved before an idle unload and restored after the next load (NSC-ME phase 4).
    if (opts.slotSavePath) args.push('--slot-save-path', opts.slotSavePath)
  }
  return args
}

/** Replace (or add) options that take one value, e.g. -t and -tb. */
function setArg(args: string[], flags: string[], value: string): void {
  for (const f of flags) {
    const i = args.indexOf(f)
    if (i >= 0) args[i + 1] = value
    else args.push(f, value)
  }
}

/**
 * Read llama-fit-params' answer (the CLI arguments it would use): `-ngl N` (-1 = all layers) and, for MoE models,
 * `-ot "blk\.K\.ffn_..._exps=CPU,..."` overrides that keep the experts of some layers in system RAM.
 */
export function parseFitPlan(out: string, totalLayers: number, ctx: number): FitPlan | null {
  const ngl = out.match(/-ngl\s+(-?\d+)/)
  if (!ngl) return null
  const n = Number(ngl[1])
  const cpuExpertLayers = new Set([...out.matchAll(/blk\\?\.(\d+)\\?\.ffn_[^=,"]*exps[^=,"]*=CPU/g)].map(m => m[1])).size
  return { gpuLayers: n < 0 ? totalLayers : Math.min(n, totalLayers), totalLayers, cpuExpertLayers, ctx }
}

/** Cumulative token counters of a llama-server (`--metrics`); differences between two reads give speeds. */
export interface ServerCounters {
  promptTokens: number
  promptSeconds: number
  predictedTokens: number
  predictedSeconds: number
}

/** Read the counters out of llama-server's Prometheus text. Missing counters → null. */
export function parseServerCounters(text: string): ServerCounters | null {
  const get = (name: string) => {
    const m = text.match(new RegExp(`^llamacpp:${name}\\s+([\\d.eE+-]+)\\s*$`, 'm'))
    return m ? Number(m[1]) : NaN
  }
  const c = {
    promptTokens: get('prompt_tokens_total'),
    promptSeconds: get('prompt_seconds_total'),
    predictedTokens: get('tokens_predicted_total'),
    predictedSeconds: get('tokens_predicted_seconds_total'),
  }
  return Object.values(c).every(Number.isFinite) ? c : null
}

/** Speeds between two counter reads; seconds are summed over slots, so this is the speed of one sequence. */
export function counterDelta(a: ServerCounters, b: ServerCounters): { promptTokens: number; outputTokens: number; promptMs: number; evalMs: number; tokensPerSecond: number } {
  const outputTokens = Math.max(0, b.predictedTokens - a.predictedTokens)
  const evalMs = Math.max(0, (b.predictedSeconds - a.predictedSeconds) * 1000)
  return {
    promptTokens: Math.max(0, b.promptTokens - a.promptTokens),
    outputTokens,
    promptMs: Math.max(0, (b.promptSeconds - a.promptSeconds) * 1000),
    evalMs,
    tokensPerSecond: evalMs > 0 ? outputTokens / (evalMs / 1000) : 0,
  }
}

export interface OpenAiTimings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

export function metricsFromTimings(t: OpenAiTimings | undefined, loadMs: number, totalMs: number): ChatMetrics {
  const outputTokens = t?.predicted_n ?? 0
  const evalMs = t?.predicted_ms ?? 0
  return {
    promptTokens: t?.prompt_n ?? 0,
    outputTokens,
    promptMs: t?.prompt_ms ?? 0,
    evalMs,
    loadMs,
    totalMs,
    tokensPerSecond: t?.predicted_per_second ?? (evalMs > 0 ? outputTokens / (evalMs / 1000) : 0),
  }
}

/** Server-sent events → JSON payloads ("data: [DONE]" ends the stream). */
export async function* readSse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
        const data = block
          .split(/\r?\n/)
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        yield JSON.parse(data) as T
      }
    }
  } finally {
    reader.releaseLock()
  }
}

interface Deps {
  /** Resolved on every use so a runtime installed while the app runs is picked up. */
  binaryDir: () => string | null
  modelsDir: string
  /** Other model folders read in place (LM Studio). */
  extraRoots?: () => ModelRoot[]
  getMode: () => NetworkMode
  /** Records model downloads (outbound) in the network log. */
  onDownload: (host: string, detail: string) => void
  /** The autotuner's saved launch profile of a model, if any (null = NETRUNNER's defaults). */
  getProfile?: (modelId: string) => LaunchProfile | null
  /** Folder for conversation state saved before an idle unload (NSC-ME phase 4); without it nothing is saved. */
  slotsDir?: string
}

/** Weights up to this size count as a small model for idle unloading: back in ≤ 9 s even from a SATA disk. */
export const SMALL_MODEL_BYTES = 6 * 2 ** 30
/** Conversations shorter than this are cheaper to read again than to save (NSC-ME phase 4: ~54 KB per token). */
export const MIN_SAVED_TOKENS = 1024
/** Saved conversation state older than this, or beyond this total size, is deleted. */
const SLOT_FILES_MAX_AGE_MS = 24 * 3600_000
const SLOT_FILES_MAX_BYTES = 16 * 2 ** 30

/**
 * Whether an idle model should be unloaded now. `idleMs` since its last use; minutes 0 = never. Under memory pressure
 * any model idle for 2 minutes goes (NSC-ME phase 3: everything it held comes back to the system).
 */
export function shouldUnloadIdle(sizeBytes: number, idleMs: number, policy: { smallMinutes: number; largeMinutes: number }, ramPressure: boolean): boolean {
  if (ramPressure && idleMs >= 2 * 60_000) return true
  const minutes = sizeBytes <= SMALL_MODEL_BYTES ? policy.smallMinutes : policy.largeMinutes
  return minutes > 0 && idleMs >= minutes * 60_000
}

/**
 * The tuned profile plus the operator's own modes: fast mode (fewer experts per token) and VRAM saver, which replaces
 * the expert cache (all experts stay in RAM).
 */
export function operatorProfile(tuned: LaunchProfile | null, expertsUsed: number | undefined, vramSaver: boolean): LaunchProfile | null {
  if (!expertsUsed && !vramSaver) return tuned
  const { moeCacheMib: _cache, ...rest } = tuned ?? {}
  return { ...(vramSaver ? rest : tuned), ...(expertsUsed ? { expertsUsed } : {}), ...(vramSaver ? { cpuMoe: true } : {}) }
}

/** Slot files of one model and launch shape: <model hash>-<ctx>x<parallel>-slot<N>.bin */
export function slotFileTag(modelId: string, ctx: number, parallel: number): string {
  return `${crypto.createHash('sha1').update(modelId).digest('hex').slice(0, 12)}-${ctx}x${parallel}`
}

/**
 * Local inference through llama.cpp's llama-server. One process per slot: `chat` (chat, agents), `embed` (project
 * memory) and `rerank` (memory search). Large models cannot share 64 GB RAM, so the chat slot swaps models on
 * demand; while the agent engine pins it, chat is answered by the agent model (it keeps a spare sequence slot
 * for that) instead of reloading. Every server listens on loopback with a random API key.
 */
export class LlamaRuntime {
  readonly catalog: ModelCatalog
  private servers = new Map<Slot, Server>()
  private starting = new Map<Slot, Promise<Server>>()
  private streams = new Map<string, AbortController>()
  private version: string | null = null
  private seq = 0
  /** Model the agent engine needs in the chat slot; chat requests for other models are refused while set. */
  pinned: string | null = null
  /** The autotuner's candidate for one model, used instead of its saved profile while it is measured. */
  launchOverride: { modelId: string; profile: LaunchProfile } | null = null
  /** Last use of each slot (a request through ensure(), or tokens counted by the server since the last look). */
  private lastUsed = new Map<Slot, number>()
  private lastTokens = new Map<Slot, number>()
  /** Conversation state saved before an idle unload, restored at the next load of the same model and shape. */
  private suspended = new Map<string, { tag: string; files: string[] }>()

  constructor(private readonly deps: Deps) {
    this.catalog = new ModelCatalog(deps.modelsDir, deps.extraRoots)
  }

  get serverBinary(): string {
    const dir = this.deps.binaryDir()
    if (!dir) throw new Error('llama.cpp runtime is not installed (MODEL VAULT → SETUP)')
    return path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  }

  async status(): Promise<RuntimeStatus> {
    const dir = this.deps.binaryDir()
    if (!dir) return { backend: 'llama.cpp', url: '', reachable: false, version: null, error: 'llama.cpp runtime is not installed' }
    if (!this.version || !this.version.startsWith(path.basename(dir))) {
      try {
        const { stdout, stderr } = await run(this.serverBinary, ['--version'], { timeout: 15000, windowsHide: true })
        const build = `${stdout}${stderr}`.match(/build (\d+)/)?.[1]
        this.version = build ? `b${build}` : path.basename(dir)
      } catch (err) {
        return { backend: 'llama.cpp', url: dir, reachable: false, version: null, error: err instanceof Error ? err.message : String(err) }
      }
    }
    return { backend: 'llama.cpp', url: dir, reachable: true, version: this.version, error: null }
  }

  async list(): Promise<ModelInfo[]> {
    return (await this.catalog.list()).map(e => ({
      name: e.id,
      label: e.name,
      source: e.source,
      kind: e.kind,
      sizeBytes: e.sizeBytes,
      modifiedAt: e.modifiedAt,
      digest: e.files[0],
      family: e.arch,
      parameterSize: e.sizeLabel,
      quantization: e.quant,
    }))
  }

  async details(id: string): Promise<ModelDetails> {
    const e = await this.catalog.get(id)
    return {
      name: e.id,
      capabilities: e.capabilities,
      contextLength: e.contextLength,
      architecture: e.arch,
      parameterCount: null,
      license: e.license,
      template: null,
      parameters: e.expertCount ? `MoE, ${e.expertCount} experts` : null,
      experts: e.expertCount && e.expertsUsed ? { total: e.expertCount, used: e.expertsUsed } : null,
    }
  }

  serverFor(slot: Slot): Server | null {
    return this.servers.get(slot) ?? null
  }

  /** Token counters of the ready server in `slot`, or null (not running, or an older build without them). */
  async counters(slot: Slot = 'chat'): Promise<(ServerCounters & { modelId: string }) | null> {
    const s = this.servers.get(slot)
    if (!s || s.state !== 'ready') return null
    try {
      const res = await fetch(`${s.url}/metrics`, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(3000) })
      const c = res.ok ? parseServerCounters(await res.text()) : null
      return c ? { ...c, modelId: s.modelId } : null
    } catch {
      return null
    }
  }

  /**
   * Start (or reuse) the server for a model in a slot. Swapping stops the previous model first. `parallel` is
   * the number of sequences it must serve at once; a server with more slots than needed is reused as is.
   */
  async ensure(slot: Slot, modelId: string, minCtx = 0, parallel = 1): Promise<Server> {
    this.lastUsed.set(slot, Date.now())
    const current = this.servers.get(slot)
    if (current && current.modelId === modelId && current.ctx >= minCtx && current.parallel >= parallel) {
      if (current.state === 'ready') return current
      const pending = this.starting.get(slot)
      if (pending) return pending
    }
    if (slot === 'chat' && this.pinned && this.pinned !== modelId) {
      throw new Error(`The agent engine is using ${this.pinned}; stop the engine to switch the chat model`)
    }
    const p = this.start(slot, modelId, minCtx, parallel)
    this.starting.set(slot, p)
    try {
      return await p
    } finally {
      if (this.starting.get(slot) === p) this.starting.delete(slot)
    }
  }

  private async start(slot: Slot, modelId: string, minCtx: number, parallel: number): Promise<Server> {
    await this.stop(slot)
    const entry = await this.catalog.get(modelId)
    if (slot === 'embed' && entry.kind !== 'embedding') throw new Error(`${entry.name} is not an embedding model`)
    if (slot === 'rerank' && entry.kind !== 'reranker') throw new Error(`${entry.name} is not a reranker`)
    if (slot === 'chat' && entry.kind !== 'chat') throw new Error(`${entry.name} is not a chat model`)
    const port = await freePort()
    const key = crypto.randomBytes(24).toString('hex')
    const ctx = Math.max(minCtx, defaultContext(entry))
    const bin = this.serverBinary
    const gpuBefore = await gpuUsedBytes()
    const np = slot === 'chat' ? Math.min(5, Math.max(1, Math.floor(parallel))) : 1
    const profile = this.launchOverride?.modelId === modelId ? this.launchOverride.profile : (this.deps.getProfile?.(modelId) ?? null)
    const mtp = profile?.mtp ?? useMtp(entry, await gpuTotalBytes())
    // NETRUNNER_SERVER_EXTRA_ARGS (measurements only): more llama-server options for the chat slot.
    const extra = slot === 'chat' ? (process.env.NETRUNNER_SERVER_EXTRA_ARGS?.split(' ').filter(Boolean) ?? []) : []
    const slotSavePath = slot === 'chat' && this.deps.slotsDir ? this.deps.slotsDir : undefined
    if (slotSavePath) await fsp.mkdir(slotSavePath, { recursive: true }).catch(() => undefined)
    const proc = spawn(bin, [...serverArgs(entry, port, key, ctx, np, { mtp, profile, slotSavePath }), ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(bin) })
    const server: Server = { slot, modelId, proc, url: `http://127.0.0.1:${port}`, key, ctx, mtp, parallel: np, state: 'loading', startedAt: Date.now(), readyMs: null, vramBytes: null, gpuBeforeBytes: gpuBefore, log: [] }
    // NETRUNNER_SERVER_LOG_DIR (measurements only): the whole server log goes to a file, not just the last lines.
    const logDir = process.env.NETRUNNER_SERVER_LOG_DIR
    const logFile = logDir ? fs.createWriteStream(path.join(logDir, `${slot}-${Date.now()}.log`), { flags: 'a' }) : null
    logFile?.write(`# ${entry.name} ctx=${ctx} parallel=${np} mtp=${mtp}\n`)
    const onData = (d: Buffer) => {
      logFile?.write(d)
      server.log.push(...d.toString().split(/\r?\n/).filter(Boolean))
      if (server.log.length > 300) server.log.splice(0, server.log.length - 300)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    this.servers.set(slot, server)

    const exited = new Promise<never>((_, reject) =>
      proc.once('exit', code => {
        if (this.servers.get(slot) === server) this.servers.delete(slot)
        reject(new Error(`llama-server exited (code ${code}) while loading ${entry.name}:\n${server.log.slice(-15).join('\n')}`))
      }),
    )
    const ready = (async () => {
      const deadline = Date.now() + 20 * 60_000
      while (Date.now() < deadline) {
        const res = await fetch(`${server.url}/health`).catch(() => null)
        if (res?.status === 200) return
        await new Promise(r => setTimeout(r, 500))
      }
      throw new Error(`${entry.name} did not become ready within 20 minutes`)
    })()
    try {
      await Promise.race([ready, exited])
    } catch (err) {
      await this.stop(slot)
      throw err
    }
    server.state = 'ready'
    server.readyMs = Date.now() - server.startedAt
    const gpuAfter = await gpuUsedBytes()
    server.vramBytes = gpuBefore !== null && gpuAfter !== null ? Math.max(0, gpuAfter - gpuBefore) : null
    this.lastUsed.set(slot, Date.now())
    this.lastTokens.delete(slot)
    if (slotSavePath) await this.restoreSlots(server, slotSavePath)
    return server
  }

  /**
   * Save the conversations a chat server holds (NSC-ME phase 4: attention KV, recurrent state and context checkpoints
   * of hybrid models; 7.5K tokens = 395 MiB, saved in ~1 s, restored in 0.3 s, answer bit-identical). Returns the
   * number of slots saved.
   */
  private async suspendSlots(s: Server, dir: string): Promise<number> {
    const auth = { Authorization: `Bearer ${s.key}` }
    try {
      const res = await fetch(`${s.url}/slots`, { headers: auth, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return 0
      const slots = (await res.json()) as { id: number; is_processing: boolean; n_prompt_tokens?: number }[]
      const tag = slotFileTag(s.modelId, s.ctx, s.parallel)
      const files: string[] = []
      for (const sl of slots) {
        if (sl.is_processing || (sl.n_prompt_tokens ?? 0) < MIN_SAVED_TOKENS) continue
        const filename = `${tag}-slot${sl.id}.bin`
        const r = await fetch(`${s.url}/slots/${sl.id}?action=save`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ filename }),
          signal: AbortSignal.timeout(2 * 60_000),
        }).catch(() => null)
        if (r?.ok) files.push(filename)
      }
      if (files.length) this.suspended.set(s.modelId, { tag, files })
      await this.pruneSlotFiles(dir)
      return files.length
    } catch {
      return 0
    }
  }

  /** Put saved conversations back into a freshly loaded server of the same model and shape; the files go either way. */
  private async restoreSlots(s: Server, dir: string): Promise<void> {
    const saved = this.suspended.get(s.modelId)
    if (!saved) return
    this.suspended.delete(s.modelId)
    if (saved.tag === slotFileTag(s.modelId, s.ctx, s.parallel)) {
      for (const filename of saved.files) {
        const id = Number(filename.match(/-slot(\d+)\.bin$/)?.[1])
        if (!Number.isInteger(id) || id >= s.parallel) continue
        await fetch(`${s.url}/slots/${id}?action=restore`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ filename }),
          signal: AbortSignal.timeout(2 * 60_000),
        }).catch(() => undefined)
      }
    }
    for (const f of saved.files) await fsp.rm(path.join(dir, f), { force: true }).catch(() => undefined)
  }

  /** Saved conversations are kept a day at most and 16 GB in total (a 65K-token agent slot is ~3.4 GB). */
  private async pruneSlotFiles(dir: string): Promise<void> {
    const names = await fsp.readdir(dir).catch(() => [] as string[])
    const files = (await Promise.all(names.filter(n => n.endsWith('.bin')).map(async n => ({ n, st: await fsp.stat(path.join(dir, n)).catch(() => null) })))).filter(f => f.st) as { n: string; st: fs.Stats }[]
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    const keep = new Set([...this.suspended.values()].flatMap(v => v.files))
    // Newest first: files of a suspended model stay while within the size cap; anything else goes when it is old or
    // over the cap (a file whose model is no longer suspended will never be restored).
    let total = 0
    const present = new Set<string>()
    for (const f of files) {
      total += f.st.size
      const live = keep.has(f.n) && total <= SLOT_FILES_MAX_BYTES && Date.now() - f.st.mtimeMs <= SLOT_FILES_MAX_AGE_MS
      if (live) present.add(f.n)
      else await fsp.rm(path.join(dir, f.n), { force: true }).catch(() => undefined)
    }
    // A model whose saved state is (partly) gone starts fresh; its remaining files go too.
    for (const [model, v] of this.suspended) {
      if (v.files.every(f => present.has(f))) continue
      this.suspended.delete(model)
      for (const f of v.files) await fsp.rm(path.join(dir, f), { force: true }).catch(() => undefined)
    }
  }

  /**
   * NSC-ME phase 3: unload models nobody used for a while (and any idle model under memory pressure), saving chat
   * conversations first. Never the agent engine's model. Returns what was unloaded.
   */
  async idleSweep(policy: { smallMinutes: number; largeMinutes: number }, ramPressure: boolean): Promise<{ modelId: string; slot: Slot; idleMin: number; savedSlots: number }[]> {
    const out: { modelId: string; slot: Slot; idleMin: number; savedSlots: number }[] = []
    for (const [slot, s] of [...this.servers]) {
      if (s.state !== 'ready' || (slot === 'chat' && this.pinned === s.modelId) || this.streams.size > 0) continue
      // Requests that bypass ensure() (the agent engine talks to the server directly) still count as use.
      const c = slot === 'chat' ? await this.counters(slot) : null
      if (c) {
        const tokens = c.promptTokens + c.predictedTokens
        if (this.lastTokens.has(slot) && this.lastTokens.get(slot) !== tokens) this.lastUsed.set(slot, Date.now())
        this.lastTokens.set(slot, tokens)
      }
      const idleMs = Date.now() - (this.lastUsed.get(slot) ?? s.startedAt)
      const e = await this.catalog.get(s.modelId).catch(() => null)
      if (!e || !shouldUnloadIdle(e.sizeBytes, idleMs, policy, ramPressure)) continue
      const savedSlots = slot === 'chat' && this.deps.slotsDir ? await this.suspendSlots(s, this.deps.slotsDir) : 0
      // Something may have started using it while the state was saved.
      if (this.servers.get(slot) !== s || this.streams.size > 0) continue
      await this.stop(slot)
      out.push({ modelId: s.modelId, slot, idleMin: Math.round(idleMs / 60_000), savedSlots })
    }
    return out
  }

  async stop(slot: Slot): Promise<void> {
    const s = this.servers.get(slot)
    this.servers.delete(slot)
    if (!s || s.proc.exitCode !== null) return
    const gone = new Promise<void>(r => s.proc.once('exit', () => r()))
    if (process.platform === 'win32' && s.proc.pid) {
      await new Promise<void>(r => execFile('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true }, () => r()))
    } else s.proc.kill()
    // Wait for the OS to release the model's memory before a larger model is loaded.
    await Promise.race([gone, new Promise(r => setTimeout(r, 10000))])
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop('chat'), this.stop('embed'), this.stop('rerank')])
  }

  /**
   * What the loaded model servers take and what they were placed around, for the interference monitor: their VRAM,
   * the VRAM others used when the first of them loaded, whether weights also live in RAM, and their process ids.
   */
  async footprint(): Promise<{ loaded: boolean; ownVramBytes: number; othersVramAtLoadBytes: number | null; weightsInRam: boolean; pids: number[] }> {
    const ready = [...this.servers.values()].filter(s => s.state === 'ready')
    let weightsInRam = false
    for (const s of ready) {
      const e = await this.catalog.get(s.modelId).catch(() => null)
      // A model bigger than the VRAM it took keeps the rest (MoE experts, layers) in system RAM.
      if (e && s.vramBytes !== null && e.sizeBytes > s.vramBytes) weightsInRam = true
    }
    const first = [...ready].sort((a, b) => a.startedAt - b.startedAt)[0]
    return {
      loaded: ready.length > 0,
      ownVramBytes: ready.reduce((n, s) => n + (s.vramBytes ?? 0), 0),
      othersVramAtLoadBytes: first?.gpuBeforeBytes ?? null,
      weightsInRam,
      pids: ready.map(s => s.proc.pid).filter((p): p is number => typeof p === 'number'),
    }
  }

  /** Loaded models; VRAM is the GPU memory the server took while loading (measured, see Server.vramBytes). */
  async running(): Promise<RunningModel[]> {
    const out: RunningModel[] = []
    for (const s of this.servers.values()) {
      const e = await this.catalog.get(s.modelId).catch(() => null)
      out.push({ name: s.modelId, sizeBytes: e?.sizeBytes ?? 0, sizeVramBytes: s.vramBytes ?? 0, contextLength: s.ctx, expiresAt: s.state })
    }
    return out
  }

  async load(id: string): Promise<void> {
    const e = await this.catalog.get(id)
    await this.ensure(e.kind === 'embedding' ? 'embed' : e.kind === 'reranker' ? 'rerank' : 'chat', id)
  }

  /**
   * Read the model files once so the OS file cache holds them: llama-server maps the weights and MoE experts that
   * stay on the CPU are otherwise paged in from disk during the first answers (Coder-Next: 4 tok/s instead of 15–20).
   * Ends with a one-token request so the first real prompt also skips CUDA warm-up.
   */
  async prewarm(modelId: string, onProgress: (done: number, total: number) => void = () => undefined): Promise<{ bytes: number; ms: number }> {
    const t0 = Date.now()
    const e = await this.catalog.get(modelId)
    const total = e.sizeBytes
    let done = 0
    const buf = Buffer.allocUnsafe(16 * 1024 * 1024)
    for (const f of e.files) {
      const fh = await fsp.open(f, 'r')
      try {
        while (true) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, null)
          if (!bytesRead) break
          done += bytesRead
          onProgress(done, total)
        }
      } finally {
        await fh.close()
      }
    }
    const s = this.servers.get('chat')
    if (s?.modelId === modelId && s.state === 'ready') {
      await fetch(`${s.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(5 * 60_000),
      }).catch(() => undefined)
    }
    return { bytes: done, ms: Date.now() - t0 }
  }

  private fitCache = new Map<string, { at: number; plan: FitPlan | null }>()

  /**
   * How llama.cpp would place the model now (default context, same KV settings as the server), from
   * llama-fit-params — the same logic `--fit` applies at load. Cached for a minute (it depends on free VRAM).
   */
  async fitPlan(id: string): Promise<FitPlan | null> {
    const hit = this.fitCache.get(id)
    if (hit && Date.now() - hit.at < 60_000) return hit.plan
    const e = await this.catalog.get(id)
    const dir = this.deps.binaryDir()
    const tool = dir ? path.join(dir, process.platform === 'win32' ? 'llama-fit-params.exe' : 'llama-fit-params') : null
    let plan: FitPlan | null = null
    if (tool && fs.existsSync(tool) && e.blocks) {
      const ctx = defaultContext(e)
      const args = ['-m', e.files[0], '-c', String(ctx), ...(e.kind === 'chat' ? ['-ctk', 'q8_0', '-ctv', 'q8_0'] : [])]
      try {
        const { stdout } = await run(tool, args, { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        plan = parseFitPlan(stdout, e.blocks, ctx)
      } catch {
        plan = null
      }
    }
    this.fitCache.set(id, { at: Date.now(), plan })
    return plan
  }

  /** Relevance of each document to the query (higher is better), from the reranker model. */
  async rerank(modelId: string, query: string, documents: string[]): Promise<number[]> {
    if (!documents.length) return []
    const s = await this.ensure('rerank', modelId)
    const res = await fetch(`${s.url}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model: modelId, query, documents, top_n: documents.length }),
      signal: AbortSignal.timeout(2 * 60_000),
    })
    if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { results: { index: number; relevance_score: number }[] }
    const scores = new Array<number>(documents.length).fill(-Infinity)
    for (const r of data.results) scores[r.index] = r.relevance_score
    return scores
  }

  async unload(id: string): Promise<void> {
    for (const [slot, s] of this.servers) {
      if (s.modelId !== id) continue
      if (slot === 'chat' && this.pinned === id) throw new Error('The agent engine is using this model; stop the engine first')
      await this.stop(slot)
    }
  }

  async remove(id: string): Promise<void> {
    const e = await this.catalog.get(id)
    // LM Studio owns its folder (and its own records of the files); NETRUNNER never deletes from it.
    if (e.source !== 'netrunner') throw new Error(`${e.name} belongs to LM Studio; delete it in LM Studio`)
    await this.unload(id)
    for (const f of e.files) await fsp.rm(f, { force: true })
  }

  async embed(modelId: string, inputs: string[]): Promise<number[][]> {
    const s = await this.ensure('embed', modelId)
    const res = await fetch(`${s.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ input: inputs, model: modelId }),
      signal: AbortSignal.timeout(5 * 60_000),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] }
    const out = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
    if (out.length !== inputs.length) throw new Error('Embedding count mismatch')
    return out
  }

  /**
   * Streaming chat; returns the stream id immediately, chunks go to `emit`. With `tools` the model may call them:
   * each call is run, its result is fed back and the answer continues (at most MAX_TOOL_ROUNDS rounds).
   */
  startChat(req: ChatRequest, emit: (c: ChatChunk) => void, tools?: ChatTools): string {
    const streamId = `chat-${Date.now()}-${++this.seq}`
    const controller = new AbortController()
    this.streams.set(streamId, controller)
    const send = (partial: Partial<ChatChunk>) => emit({ streamId, content: '', thinking: '', done: false, error: null, metrics: null, ...partial })

    void (async () => {
      const t0 = Date.now()
      try {
        // While the agent engine holds the chat slot, its model answers (spare slot) instead of a 20–100 s reload.
        const model = this.pinned && this.pinned !== req.model ? this.pinned : req.model
        if (req.messages.some(m => m.images?.length) && !(await this.catalog.get(model)).mmproj) {
          throw new Error(
            model === req.model
              ? 'This model cannot see images (no mmproj vision projector next to it)'
              : 'The agent model answers while the agent engine runs and it cannot see images; stop the engine to use the vision model',
          )
        }
        const before = this.servers.get('chat')
        const s = model === req.model ? await this.ensure('chat', model, req.contextLength ?? 0) : await this.ensure('chat', model)
        send({ servedModel: model })
        const loadMs = before === s ? 0 : s.readyMs ?? 0
        // Pictures go as OpenAI-style content parts; llama-server feeds them through the model's mmproj.
        const messages: Record<string, unknown>[] = req.messages.map(m =>
          m.images?.length
            ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))] }
            : { role: m.role, content: m.content },
        )
        let timings: OpenAiTimings | undefined
        let wrote = false
        // Set when a tool reported that the computer is offline: the next round gets no tools, so the model answers.
        let offline = false
        for (let round = 0; ; round++) {
          if (tools) fitToolResults(messages, s.ctx)
          const post = () => {
            const body: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } }
            if (tools && !offline && round < MAX_TOOL_ROUNDS) {
              body.tools = tools.defs.map(d => ({ type: 'function', function: d }))
              // WEB on means "look it up": the first step must be a tool call. Left free, the model sometimes answered
              // from memory and even claimed sources it never opened (seen in 2 of 6 live questions).
              if (round === 0) body.tool_choice = 'required'
            }
            if (req.temperature !== null) body.temperature = req.temperature
            if (req.think !== null) body.chat_template_kwargs = { enable_thinking: req.think }
            return fetch(`${s.url}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.key}` },
              body: JSON.stringify(body),
              signal: controller.signal,
            })
          }
          let res = await post()
          if (res.status === 400 && tools && round > 0) {
            const detail = await res.text()
            if (!/exceed_context_size|context size/i.test(detail)) throw new Error(`llama-server 400: ${detail}`)
            // The estimate was too generous for this text: cut every tool result down and try once more.
            fitToolResults(messages, s.ctx, true)
            res = await post()
          }
          if (!res.ok || !res.body) throw new Error(`llama-server ${res.status}: ${await res.text()}`)
          const filter = new ThinkLeakFilter()
          const calls: { id: string; name: string; args: string }[] = []
          let text = ''
          for await (const ev of readSse<{
            choices?: {
              delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
              finish_reason?: string | null
            }[]
            timings?: OpenAiTimings
            error?: { message?: string }
          }>(res.body)) {
            if (ev.error) throw new Error(ev.error.message ?? 'llama-server error')
            if (ev.timings) timings = ev.timings
            const d = ev.choices?.[0]?.delta
            for (const tc of d?.tool_calls ?? []) {
              const i = tc.index ?? calls.length - 1
              calls[i] ??= { id: tc.id ?? `call-${round}-${i}`, name: '', args: '' }
              if (tc.id) calls[i].id = tc.id
              calls[i].name += tc.function?.name ?? ''
              calls[i].args += tc.function?.arguments ?? ''
            }
            let content = filter.push(d?.content ?? '')
            // A new round of text after earlier text (or tool calls) starts on its own paragraph.
            if (content && !text && wrote) content = `\n\n${content}`
            text += content
            if (content || d?.reasoning_content) send({ content, thinking: d?.reasoning_content ?? '' })
          }
          const rest = filter.end()
          if (rest) send({ content: rest })
          text += rest
          wrote ||= !!text
          if (!tools || !calls.length || round >= MAX_TOOL_ROUNDS) break
          messages.push({ role: 'assistant', content: text || null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) })
          for (const c of calls) {
            send({ tool: { id: c.id, name: c.name, args: c.args, status: 'running' } })
            let args: Record<string, unknown> = {}
            let result: string
            try {
              args = c.args.trim() ? (JSON.parse(c.args) as Record<string, unknown>) : {}
              result = await tools.run(c.name, args, controller.signal)
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`
            }
            if (controller.signal.aborted) throw new Error('stopped')
            send({ tool: { id: c.id, name: c.name, args: c.args, status: result.startsWith('Error:') ? 'error' : 'done', result: result.slice(0, 4000) } })
            messages.push({ role: 'tool', tool_call_id: c.id, content: result.slice(0, 12_000) })
            if (result.includes('NO_INTERNET')) offline = true
          }
          wrote = true
        }
        send({ done: true, servedModel: model, metrics: metricsFromTimings(timings, loadMs, Date.now() - t0) })
      } catch (err) {
        send({ done: true, error: controller.signal.aborted ? 'stopped' : err instanceof Error ? err.message : String(err) })
      } finally {
        this.streams.delete(streamId)
      }
    })()
    return streamId
  }

  stopStream(id: string): void {
    this.streams.get(id)?.abort()
  }

  // ------------------------------------------------------------------------------------------
  // Downloads from Hugging Face ("owner/repo:QUANT"), ONLINE TOOLS only
  // ------------------------------------------------------------------------------------------

  startPull(spec: string, emit: (p: PullProgress) => void): string {
    assertOnlineAllowed(this.deps.getMode(), 'Model download')
    const m = spec.trim().match(/^([\w.-]+\/[\w.-]+):([\w.-]+)$/)
    if (!m) throw new Error('Use the form owner/repo:QUANT, e.g. Qwen/Qwen3-Coder-Next-GGUF:Q4_K_M')
    const [, repo, quant] = m
    const pullId = `pull-${Date.now()}-${++this.seq}`
    const controller = new AbortController()
    this.streams.set(pullId, controller)
    const send = (p: Partial<PullProgress>) => emit({ pullId, model: spec, status: '', completedBytes: null, totalBytes: null, done: false, error: null, ...p })

    void (async () => {
      try {
        this.deps.onDownload('huggingface.co', `${repo} file list`)
        const tree = (await (await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { signal: controller.signal })).json()) as { type: string; path: string; size: number }[]
        const files = selectRepoFiles(tree, quant)
        if (!files.length) throw new Error(`No GGUF files matching ${quant} in ${repo}`)
        const total = files.reduce((a, f) => a + f.size, 0)
        let doneBytes = 0
        for (const f of files) {
          const target = path.join(this.deps.modelsDir, ...repo.split('/'), ...f.path.split('/'))
          await fsp.mkdir(path.dirname(target), { recursive: true })
          if ((await fsp.stat(target).catch(() => null))?.size === f.size) {
            doneBytes += f.size
            continue
          }
          const part = `${target}.part`
          const have = (await fsp.stat(part).catch(() => null))?.size ?? 0
          this.deps.onDownload('huggingface.co', `${repo}/${f.path}`)
          const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${f.path}`, {
            headers: have ? { Range: `bytes=${have}-` } : {},
            signal: controller.signal,
          })
          if (!res.ok || !res.body) throw new Error(`download ${f.path}: HTTP ${res.status}`)
          const resumed = res.status === 206
          const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })
          let got = resumed ? have : 0
          const reader = res.body.getReader()
          let last = 0
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()))
            traffic.add('model-download', 0, value.length)
            got += value.length
            if (Date.now() - last > 500) {
              last = Date.now()
              send({ status: `${f.path}`, completedBytes: doneBytes + got, totalBytes: total })
            }
          }
          await new Promise<void>((r, j) => out.end((e?: Error) => (e ? j(e) : r())))
          if (got !== f.size) throw new Error(`download ${f.path}: got ${got} of ${f.size} bytes`)
          await fsp.rename(part, target)
          doneBytes += f.size
        }
        send({ status: 'success', completedBytes: total, totalBytes: total, done: true })
      } catch (err) {
        send({ done: true, error: controller.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err) })
      } finally {
        this.streams.delete(pullId)
      }
    })()
    return pullId
  }
}

/** Files of one quantisation (folder or file-name match) plus the best multimodal projector, if any. */
export function selectRepoFiles(tree: { type: string; path: string; size: number }[], quant: string): { path: string; size: number }[] {
  const q = quant.toLowerCase()
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "Q4_K_M" must not also select Unsloth's "UD-Q4_K_M" (and vice versa), which often share a repo.
  const notUd = q.startsWith('ud-') ? '' : '(?<!ud-)'
  const fileRe = new RegExp(`[-_.]${notUd}${esc}(-\\d{5}-of-\\d{5})?\\.gguf$`)
  const gguf = tree.filter(t => t.type === 'file' && /\.gguf$/i.test(t.path))
  const models = gguf.filter(t => !/(^|\/)mmproj/i.test(t.path)).filter(t => {
    const p = t.path.toLowerCase()
    return p.startsWith(`${q}/`) || fileRe.test(p)
  })
  if (!models.length) return []
  const proj = gguf.filter(t => /(^|\/)mmproj/i.test(t.path)).sort((a, b) => (isF16(b.path) ? 1 : 0) - (isF16(a.path) ? 1 : 0))[0]
  return [...models, ...(proj ? [proj] : [])].map(t => ({ path: t.path, size: t.size }))
}
