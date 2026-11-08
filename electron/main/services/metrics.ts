import type { ChatMetrics, InferenceMetric, ModelPerf, NetLogEntry, TaskPerf } from '../../shared/ipc'
import type { Database } from './db'

const MAX_NET_LOG = 5000

/** Measured inference runs and agent task durations, from SQLite. */
export class MetricsStore {
  /** onRun: after each recorded run, its speed and the model's earlier speeds from the same source (newest first). */
  constructor(
    private readonly store: Database,
    private readonly onRun: (model: string, tokensPerSecond: number, earlier: number[]) => void = () => undefined,
  ) {}

  private notify(model: string, source: 'chat' | 'agent', tokensPerSecond: number): void {
    const earlier = (this.store.db
      .prepare('SELECT tokens_per_second AS tps FROM inference_metrics WHERE model = ? AND source = ? ORDER BY id DESC LIMIT 21')
      .all(model, source) as { tps: number }[]).slice(1).map(r => Number(r.tps))
    this.onRun(model, tokensPerSecond, earlier)
  }

  recordChat(model: string, m: ChatMetrics): void {
    // Runs without generated tokens (errors, aborts before output) carry no speed information.
    if (m.outputTokens <= 0 || m.evalMs <= 0) return
    this.store.db
      .prepare(
        `INSERT INTO inference_metrics (time, source, model, prompt_tokens, output_tokens, tokens_per_second, prompt_ms, load_ms, total_ms)
         VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), model, m.promptTokens, m.outputTokens, m.tokensPerSecond, m.promptMs, m.loadMs, m.totalMs)
    this.notify(model, 'chat', m.tokensPerSecond)
  }

  /**
   * Agent task speed, from llama-server's token counters read when the task started and finished. With several
   * jobs at once the counters cover all of them; seconds are per slot, so the speed is that of one sequence.
   */
  recordAgent(model: string, taskId: number, m: Omit<ChatMetrics, 'loadMs' | 'totalMs'> & { totalMs: number }): void {
    if (m.outputTokens <= 0 || m.evalMs <= 0) return
    this.store.db
      .prepare(
        `INSERT INTO inference_metrics (time, source, model, prompt_tokens, output_tokens, tokens_per_second, prompt_ms, load_ms, total_ms, task_id)
         VALUES (?, 'agent', ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(new Date().toISOString(), model, m.promptTokens, m.outputTokens, m.tokensPerSecond, m.promptMs, m.totalMs, taskId)
    this.notify(model, 'agent', m.tokensPerSecond)
  }

  /** Speeds of a model's runs before and after a moment, per source (the last 20 before, up to 50 after). */
  speedsAround(model: string, at: string): { source: 'chat' | 'agent'; before: number[]; after: number[] }[] {
    const db = this.store.db
    return (['chat', 'agent'] as const).map(source => ({
      source,
      before: (db.prepare('SELECT tokens_per_second AS t FROM inference_metrics WHERE model = ? AND source = ? AND time < ? ORDER BY id DESC LIMIT 20').all(model, source, at) as { t: number }[]).map(r => Number(r.t)),
      after: (db.prepare('SELECT tokens_per_second AS t FROM inference_metrics WHERE model = ? AND source = ? AND time >= ? ORDER BY id LIMIT 50').all(model, source, at) as { t: number }[]).map(r => Number(r.t)),
    }))
  }

  inference(limit = 200): { recent: InferenceMetric[]; perModel: ModelPerf[] } {
    const db = this.store.db
    const recent = (db.prepare('SELECT * FROM inference_metrics ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(2000, limit))) as Record<string, number | string>[])
      .map(r => ({
        id: Number(r.id),
        time: String(r.time),
        source: (r.source === 'agent' ? 'agent' : 'chat') as InferenceMetric['source'],
        model: String(r.model),
        promptTokens: Number(r.prompt_tokens),
        outputTokens: Number(r.output_tokens),
        tokensPerSecond: Number(r.tokens_per_second),
        promptMs: Number(r.prompt_ms),
        loadMs: Number(r.load_ms),
        totalMs: Number(r.total_ms),
      }))
      .reverse()
    const perModel = (db
      .prepare(
        `SELECT model, COUNT(*) AS runs, AVG(tokens_per_second) AS avg_tps, MAX(tokens_per_second) AS best_tps,
                AVG(CASE WHEN prompt_ms > 0 THEN prompt_tokens * 1000.0 / prompt_ms END) AS avg_prompt_tps,
                AVG(load_ms) AS avg_load
         FROM inference_metrics GROUP BY model ORDER BY avg_tps DESC`,
      )
      .all() as Record<string, number | string | null>[]).map(r => ({
      model: String(r.model),
      runs: Number(r.runs),
      avgTokensPerSecond: Number(r.avg_tps),
      bestTokensPerSecond: Number(r.best_tps),
      avgPromptTokensPerSecond: Number(r.avg_prompt_tps ?? 0),
      avgLoadMs: Number(r.avg_load ?? 0),
    }))
    return { recent, perModel }
  }

  tasks(): TaskPerf[] {
    return (this.store.db
      .prepare(
        `SELECT t.role AS role, COUNT(*) AS runs,
                SUM(t.status = 'done') AS done, SUM(t.status IN ('failed','interrupted')) AS failed,
                AVG(CASE WHEN t.started_at IS NOT NULL AND t.finished_at IS NOT NULL
                         THEN (julianday(t.finished_at) - julianday(t.started_at)) * 86400 END) AS avg_s,
                (SELECT AVG(m.tokens_per_second) FROM inference_metrics m JOIN tasks t2 ON t2.id = m.task_id
                  WHERE m.source = 'agent' AND t2.role = t.role) AS avg_tps
         FROM tasks t WHERE t.started_at IS NOT NULL GROUP BY t.role ORDER BY t.role`,
      )
      .all() as Record<string, number | string | null>[]).map(r => ({
      role: r.role as TaskPerf['role'],
      runs: Number(r.runs),
      done: Number(r.done ?? 0),
      failed: Number(r.failed ?? 0),
      avgSeconds: Number(r.avg_s ?? 0),
      avgTokensPerSecond: r.avg_tps === null ? null : Number(r.avg_tps),
    }))
  }
}

/** Persistent network activity log (every proxied request plus blocked renderer requests). */
export class NetLog {
  constructor(
    private readonly store: Database,
    private readonly onEntry: (e: NetLogEntry) => void,
  ) {}

  record(e: Omit<NetLogEntry, 'id'>): NetLogEntry {
    const db = this.store.db
    const { lastInsertRowid } = db
      .prepare('INSERT INTO network_log (time, source, method, host, port, allowed, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.time, e.source, e.method, e.host, e.port, e.allowed ? 1 : 0, e.reason)
    const id = Number(lastInsertRowid)
    if (id % 500 === 0) db.prepare('DELETE FROM network_log WHERE id <= ?').run(id - MAX_NET_LOG)
    const entry = { ...e, id }
    this.onEntry(entry)
    return entry
  }

  list(limit = 1000): NetLogEntry[] {
    return (this.store.db.prepare('SELECT * FROM network_log ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(MAX_NET_LOG, limit))) as Record<string, number | string>[])
      .map(r => ({
        id: Number(r.id),
        time: String(r.time),
        source: String(r.source),
        method: String(r.method),
        host: String(r.host),
        port: Number(r.port),
        allowed: !!r.allowed,
        reason: String(r.reason),
      }))
      .reverse()
  }

  clear(): void {
    this.store.db.exec('DELETE FROM network_log')
  }
}
