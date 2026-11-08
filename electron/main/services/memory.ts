import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MemoryHit, MemoryProgress, MemoryStatus } from '../../shared/ipc'
import type { Database } from './db'

export const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.md', '.css', '.scss', '.html', '.json', '.yml', '.yaml', '.toml',
  '.rs', '.go', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.ps1', '.sh', '.sql', '.lua', '.rb', '.php', '.swift', '.vue', '.svelte',
])
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'release', 'build', 'out', 'target', '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', 'coverage', 'test-results', '.idea', '.vscode', 'unsloth_compiled_cache',
])
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock'])
const MAX_FILE_BYTES = 300_000
const CHUNK_LINES = 60
const OVERLAP = 10
const BATCH = 16

/** Qwen3-Embedding is trained with an instruction prefix on the query side only. */
export const QUERY_INSTRUCTION = 'Instruct: Given a question or description, retrieve the relevant code or documentation from the project\nQuery: '

export interface Chunk {
  startLine: number
  endLine: number
  content: string
}

/** Fixed-size line windows with overlap; tiny trailing windows are merged into the previous one. */
export function chunkText(text: string, size = CHUNK_LINES, overlap = OVERLAP): Chunk[] {
  const lines = text.split(/\r?\n/)
  const chunks: Chunk[] = []
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(lines.length, start + size)
    const content = lines.slice(start, end).join('\n')
    if (content.trim().length > 0) chunks.push({ startLine: start + 1, endLine: end, content })
    if (end === lines.length) break
  }
  return chunks
}

export async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name))
      } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name).toLowerCase()) && !SKIP_FILES.has(e.name)) {
        out.push(path.join(dir, e.name))
      }
    }
  }
  await walk(root)
  return out.sort()
}

const toBlob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer)

/**
 * Text for the word index: the path and the code, with identifiers also split into words
 * (resolveInWorkspace → resolve In Workspace, net_proxy → net proxy) so plain-language queries match code names.
 */
export function wordsFor(path: string, content: string): string {
  const split = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-./\\]+/g, ' ')
  return `${path} ${split(path)}\n${content}\n${split(content.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g)?.join(' ') ?? '')}`
}

const STOP = new Set('a an and are as at be by does do for from how i in into is it of on or the this that to what when where which who why with where'.split(' '))

/** FTS5 query from free text: significant words (and their split identifier parts) as OR-ed prefix terms. */
export function ftsQuery(text: string): string | null {
  const words = new Set<string>()
  for (const raw of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    for (const w of [raw, ...raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/)]) {
      const lw = w.toLowerCase()
      if (lw.length >= 3 && !STOP.has(lw)) words.add(lw)
    }
  }
  return words.size ? [...words].slice(0, 24).map(w => `"${w.replace(/"/g, '')}"*`).join(' OR ') : null
}

/** Reciprocal-rank fusion of several rankings of chunk ids (k = 60, the usual constant). */
export function fuseRankings(rankings: number[][], k = 60): number[] {
  const score = new Map<number, number>()
  for (const ranking of rankings) ranking.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

export type SearchMode = 'vector' | 'hybrid' | 'rerank'

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i

/**
 * "Where is X done" means the implementation: a test of the same module tends to win on words and meaning alike,
 * so test files move three places down unless the query is about tests.
 */
export function demoteTests<T extends { path: string }>(hits: T[], query: string): T[] {
  if (/\b(tests?|spec)\b|тест/i.test(query)) return hits
  return hits
    .map((h, i) => ({ h, key: i + (TEST_PATH.test(h.path) ? 3.5 : 0) }))
    .sort((a, b) => a.key - b.key)
    .map(x => x.h)
}

/**
 * Semantic memory of a workspace: code chunks embedded with a local model and stored in sqlite-vec.
 * Re-indexing only embeds files whose content hash changed.
 */
export class MemoryService {
  private running = false

  constructor(
    private readonly store: Database,
    private readonly embed: (model: string, inputs: string[]) => Promise<number[][]>,
    /** Embedding model id; may reject when none is installed. */
    private readonly getModel: () => string | Promise<string>,
    /** Reranker scores for (query, documents), or null when no reranker model is installed. */
    private readonly rerank: (query: string, documents: string[]) => Promise<number[] | null> = async () => null,
  ) {}

  /** Word-index rows for chunks indexed before the word index existed. */
  private backfillWords(workspace: string): void {
    const db = this.store.db
    const missing = db
      .prepare('SELECT c.id, c.path, c.content FROM memory_chunks c LEFT JOIN memory_fts f ON f.rowid = c.id WHERE c.workspace = ? AND f.rowid IS NULL')
      .all(workspace) as { id: number; path: string; content: string }[]
    if (!missing.length) return
    const ins = db.prepare('INSERT INTO memory_fts (rowid, workspace, words) VALUES (?, ?, ?)')
    this.store.tx(() => {
      for (const m of missing) ins.run(BigInt(m.id), workspace, wordsFor(m.path, m.content))
    })
  }

  private vecTable(dims: number): string {
    if (!Number.isInteger(dims) || dims < 8 || dims > 8192) throw new Error(`Bad embedding size ${dims}`)
    const name = `memory_vec_${dims}`
    this.store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(workspace text partition key, embedding float[${dims}] distance_metric=cosine)`)
    return name
  }

  async status(workspace: string): Promise<MemoryStatus> {
    const configuredModel = await Promise.resolve(this.getModel()).catch(() => '(none installed)')
    const db = this.store.db
    const meta = db.prepare('SELECT model, dims, indexed_at FROM memory_meta WHERE workspace = ?').get(workspace) as
      | { model: string; dims: number; indexed_at: string }
      | undefined
    const files = (db.prepare('SELECT COUNT(*) AS n FROM memory_files WHERE workspace = ?').get(workspace) as { n: number }).n
    const chunks = (db.prepare('SELECT COUNT(*) AS n FROM memory_chunks WHERE workspace = ?').get(workspace) as { n: number }).n
    return {
      workspace,
      model: meta?.model ?? null,
      dims: meta ? Number(meta.dims) : null,
      files: Number(files),
      chunks: Number(chunks),
      indexedAt: meta?.indexed_at ?? null,
      indexing: this.running,
      configuredModel,
    }
  }

  private removeFile(workspace: string, rel: string, table: string | null): void {
    const db = this.store.db
    const ids = db.prepare('SELECT id FROM memory_chunks WHERE workspace = ? AND path = ?').all(workspace, rel) as { id: number }[]
    if (table) {
      const del = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`)
      for (const { id } of ids) del.run(BigInt(id))
    }
    const delWords = db.prepare('DELETE FROM memory_fts WHERE rowid = ?')
    for (const { id } of ids) delWords.run(BigInt(id))
    db.prepare('DELETE FROM memory_chunks WHERE workspace = ? AND path = ?').run(workspace, rel)
    db.prepare('DELETE FROM memory_files WHERE workspace = ? AND path = ?').run(workspace, rel)
  }

  /** Drop the whole index of a workspace (e.g. after switching the embedding model). */
  clear(workspace: string): void {
    const meta = this.store.db.prepare('SELECT dims FROM memory_meta WHERE workspace = ?').get(workspace) as { dims: number } | undefined
    this.store.tx(() => {
      if (meta) this.store.db.prepare(`DELETE FROM ${this.vecTable(Number(meta.dims))} WHERE workspace = ?`).run(workspace)
      this.store.db.prepare('DELETE FROM memory_fts WHERE workspace = ?').run(workspace)
      this.store.db.prepare('DELETE FROM memory_chunks WHERE workspace = ?').run(workspace)
      this.store.db.prepare('DELETE FROM memory_files WHERE workspace = ?').run(workspace)
      this.store.db.prepare('DELETE FROM memory_meta WHERE workspace = ?').run(workspace)
    })
  }

  async index(workspace: string, onProgress: (p: MemoryProgress) => void = () => undefined): Promise<MemoryProgress> {
    if (this.running) throw new Error('Indexing already in progress')
    const model = await this.getModel()
    this.running = true
    const db = this.store.db
    const started = Date.now()
    const progress: MemoryProgress = { workspace, phase: 'scanning', filesTotal: 0, filesDone: 0, chunksEmbedded: 0, filesSkipped: 0, filesRemoved: 0, error: null, seconds: 0 }
    const tick = () => onProgress({ ...progress, seconds: (Date.now() - started) / 1000 })
    try {
      const meta = db.prepare('SELECT model, dims FROM memory_meta WHERE workspace = ?').get(workspace) as { model: string; dims: number } | undefined
      if (meta && meta.model !== model) this.clear(workspace) // different vector space: start over

      const files = await collectFiles(workspace)
      const known = new Map(
        (db.prepare('SELECT path, hash FROM memory_files WHERE workspace = ?').all(workspace) as { path: string; hash: string }[]).map(r => [r.path, r.hash]),
      )
      progress.filesTotal = files.length
      progress.phase = 'embedding'
      tick()

      let table: string | null = meta && meta.model === model ? this.vecTable(Number(meta.dims)) : null
      const seen = new Set<string>()
      for (const abs of files) {
        const rel = path.relative(workspace, abs).split(path.sep).join('/')
        seen.add(rel)
        const buf = await fs.readFile(abs).catch(() => null)
        if (!buf || buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) {
          progress.filesSkipped++
          progress.filesDone++
          continue
        }
        const hash = crypto.createHash('sha1').update(buf).digest('hex')
        if (known.get(rel) === hash) {
          progress.filesDone++
          continue
        }
        const chunks = chunkText(buf.toString('utf8'))
        const vectors: number[][] = []
        for (let i = 0; i < chunks.length; i += BATCH) {
          const batch = chunks.slice(i, i + BATCH)
          vectors.push(...(await this.embed(model, batch.map(c => `File: ${rel} (lines ${c.startLine}-${c.endLine})\n${c.content}`))))
        }
        if (!table && vectors.length) {
          table = this.vecTable(vectors[0].length)
          db.prepare('INSERT OR REPLACE INTO memory_meta (workspace, model, dims, indexed_at) VALUES (?, ?, ?, ?)').run(workspace, model, vectors[0].length, new Date().toISOString())
        }
        this.store.tx(() => {
          this.removeFile(workspace, rel, table)
          const insChunk = db.prepare('INSERT INTO memory_chunks (workspace, path, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)')
          const insVec = table ? db.prepare(`INSERT INTO ${table} (rowid, workspace, embedding) VALUES (?, ?, ?)`) : null
          const insWords = db.prepare('INSERT INTO memory_fts (rowid, workspace, words) VALUES (?, ?, ?)')
          chunks.forEach((c, i) => {
            const { lastInsertRowid } = insChunk.run(workspace, rel, c.startLine, c.endLine, c.content)
            insVec?.run(BigInt(lastInsertRowid), workspace, toBlob(vectors[i]))
            insWords.run(BigInt(lastInsertRowid), workspace, wordsFor(rel, c.content))
          })
          db.prepare('INSERT OR REPLACE INTO memory_files (workspace, path, hash, indexed_at) VALUES (?, ?, ?, ?)').run(workspace, rel, hash, new Date().toISOString())
        })
        progress.chunksEmbedded += chunks.length
        progress.filesDone++
        tick()
      }

      for (const rel of known.keys()) {
        if (!seen.has(rel)) {
          this.store.tx(() => this.removeFile(workspace, rel, table))
          progress.filesRemoved++
        }
      }
      db.prepare('UPDATE memory_meta SET indexed_at = ? WHERE workspace = ?').run(new Date().toISOString(), workspace)
      progress.phase = 'done'
    } catch (err) {
      progress.phase = 'error'
      progress.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.running = false
      tick()
    }
    return { ...progress, seconds: (Date.now() - started) / 1000 }
  }

  /**
   * Search the project memory. `hybrid`: the embedding ranking and the word ranking (BM25 over code and split
   * identifiers) fused; `rerank` (default, when a reranker model is installed): the top fused chunks re-scored by
   * the reranker, which reads query and code together. `vector` is the embedding ranking alone.
   */
  async search(workspace: string, query: string, k = 8, mode: SearchMode = 'rerank'): Promise<MemoryHit[]> {
    const db = this.store.db
    const meta = db.prepare('SELECT model, dims FROM memory_meta WHERE workspace = ?').get(workspace) as { model: string; dims: number } | undefined
    if (!meta) return []
    const limit = Math.max(1, Math.min(50, k))
    const pool = mode === 'vector' ? limit : 40
    const [vec] = await this.embed(meta.model, [QUERY_INSTRUCTION + query])
    const table = this.vecTable(Number(meta.dims))
    const vectorRows = db
      .prepare(`SELECT v.rowid AS id, v.distance FROM ${table} v WHERE v.embedding MATCH ? AND v.k = ? AND v.workspace = ? ORDER BY v.distance`)
      .all(toBlob(vec), pool, workspace) as { id: number; distance: number }[]
    const similarity = new Map(vectorRows.map(r => [Number(r.id), 1 - Number(r.distance)]))
    let ids = vectorRows.map(r => Number(r.id))
    if (mode !== 'vector') {
      this.backfillWords(workspace)
      const q = ftsQuery(query)
      const wordIds = q
        ? (db.prepare('SELECT rowid AS id FROM memory_fts WHERE memory_fts MATCH ? AND workspace = ? ORDER BY bm25(memory_fts) LIMIT ?').all(q, workspace, pool) as { id: number }[]).map(r => Number(r.id))
        : []
      ids = fuseRankings([ids, wordIds])
    }
    const load = db.prepare('SELECT id, path, start_line, end_line, content FROM memory_chunks WHERE id = ?')
    let hits = ids.slice(0, mode === 'rerank' ? 20 : limit).map(id => {
      const r = load.get(id) as { id: number; path: string; start_line: number; end_line: number; content: string }
      return { path: r.path, startLine: Number(r.start_line), endLine: Number(r.end_line), content: r.content, score: similarity.get(id) ?? 0 }
    })
    if (mode === 'rerank' && hits.length > 1) {
      const scores = await this.rerank(query, hits.map(h => `File: ${h.path} (lines ${h.startLine}-${h.endLine})\n${h.content.slice(0, 2000)}`)).catch(() => null)
      if (scores) {
        // The reranker's order is fused with the hybrid order rather than replacing it: alone it fixed as many
        // queries as it broke on the 26-question test, fused it keeps the wins of both.
        const byRerank = hits.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
        const fused = fuseRankings([hits.map((_, i) => i), byRerank])
        hits = fused.map(i => ({ ...hits[i], score: scores[i] }))
      }
    }
    return demoteTests(hits, query).slice(0, limit)
  }
}

/** Render search hits as a context block for a prompt. */
export function formatMemoryContext(hits: MemoryHit[], maxChars = 12000): string {
  let out = 'Relevant code from the project memory (local semantic search):\n'
  for (const h of hits) {
    const block = `\n--- ${h.path} (lines ${h.startLine}-${h.endLine}, similarity ${h.score.toFixed(2)})\n${h.content}\n`
    if (out.length + block.length > maxChars) break
    out += block
  }
  return out
}
