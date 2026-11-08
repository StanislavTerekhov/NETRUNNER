import fs from 'node:fs/promises'
import path from 'node:path'
import type { Conversation, ConversationSummary } from '../../shared/ipc'
import type { Database } from './db'

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_CONVERSATION_CHARS = 20_000_000

interface Row {
  id: string
  title: string
  model: string
  created_at: string
  updated_at: string
  system_prompt: string
  messages_json: string
}

/** Chat history in SQLite. */
export class ConversationStore {
  constructor(private readonly store: Database) {}

  private check(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid conversation id: ${id}`)
    return id
  }

  list(): ConversationSummary[] {
    const rows = this.store.db
      .prepare(`SELECT id, title, model, updated_at, json_array_length(messages_json) AS n FROM conversations ORDER BY updated_at DESC`)
      .all() as { id: string; title: string; model: string; updated_at: string; n: number }[]
    return rows.map(r => ({ id: r.id, title: r.title, model: r.model, updatedAt: r.updated_at, messageCount: Number(r.n) }))
  }

  get(id: string): Conversation {
    const r = this.store.db.prepare('SELECT * FROM conversations WHERE id = ?').get(this.check(id)) as Row | undefined
    if (!r) throw new Error(`Conversation not found: ${id}`)
    return {
      id: r.id,
      title: r.title,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      systemPrompt: r.system_prompt,
      messages: JSON.parse(r.messages_json),
    }
  }

  save(c: Conversation): void {
    if (!Array.isArray(c.messages) || typeof c.title !== 'string') throw new Error('Malformed conversation')
    const messages = JSON.stringify(c.messages)
    if (messages.length > MAX_CONVERSATION_CHARS) throw new Error('Conversation is too large to store')
    this.store.db
      .prepare(
        `INSERT INTO conversations (id, title, model, created_at, updated_at, system_prompt, messages_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, model = excluded.model, updated_at = excluded.updated_at,
           system_prompt = excluded.system_prompt, messages_json = excluded.messages_json`,
      )
      .run(this.check(c.id), c.title.slice(0, 200), String(c.model), String(c.createdAt), String(c.updatedAt), String(c.systemPrompt ?? ''), messages)
  }

  /**
   * Conversations whose title or message text contains every word of the query (case-insensitive, any
   * script — done in JS because SQLite's LIKE folds case for ASCII only). Attached images are not searched.
   */
  search(query: string, limit = 50): (ConversationSummary & { snippet: string })[] {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
    if (!words.length) return []
    const rows = this.store.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as Row[]
    const out: (ConversationSummary & { snippet: string })[] = []
    for (const r of rows) {
      const messages = JSON.parse(r.messages_json) as Conversation['messages']
      const texts = [r.title, ...messages.map(m => m.content)]
      const all = texts.join('\n').toLocaleLowerCase()
      if (!words.every(w => all.includes(w))) continue
      const hit = texts.find(t => t.toLocaleLowerCase().includes(words[0])) ?? r.title
      const at = Math.max(0, hit.toLocaleLowerCase().indexOf(words[0]) - 40)
      out.push({
        id: r.id,
        title: r.title,
        model: r.model,
        updatedAt: r.updated_at,
        messageCount: messages.length,
        snippet: `${at > 0 ? '…' : ''}${hit.slice(at, at + 140).replace(/\s+/g, ' ')}`,
      })
      if (out.length >= limit) break
    }
    return out
  }

  /** The conversation as Markdown (images are listed, not embedded) or as the stored JSON. */
  export(id: string, format: 'md' | 'json'): string {
    const c = this.get(id)
    if (format === 'json') return JSON.stringify(c, null, 2)
    const lines = [`# ${c.title}`, '', `- model: \`${c.model}\``, `- created: ${c.createdAt}`, `- updated: ${c.updatedAt}`, '']
    if (c.systemPrompt.trim()) lines.push('## System prompt', '', c.systemPrompt, '')
    for (const m of c.messages) {
      lines.push(`## ${m.role === 'user' ? 'Operator' : m.role === 'assistant' ? 'NEURAL CORE' : 'System'}`, '')
      if (m.images?.length) lines.push(`_${m.images.length} attached image(s)_`, '')
      lines.push(m.content || '_(empty)_', '')
      if (m.metrics) lines.push(`_${m.metrics.tokensPerSecond.toFixed(1)} tok/s · ${m.metrics.outputTokens} tokens_`, '')
      if (m.error) lines.push(`_error: ${m.error}_`, '')
    }
    return lines.join('\n')
  }

  remove(id: string): void {
    this.store.db.prepare('DELETE FROM conversations WHERE id = ?').run(this.check(id))
  }

  /**
   * One-time import of the phase-2 JSON files. The folder is renamed afterwards (kept as a backup),
   * so the import never runs twice. Returns the number of imported conversations.
   */
  async importJsonDir(dir: string): Promise<number> {
    const names = await fs.readdir(dir).catch(() => null)
    if (!names) return 0
    let n = 0
    for (const name of names.filter(f => f.endsWith('.json'))) {
      try {
        const c = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Conversation
        this.save(c)
        n++
      } catch {
        /* skip unreadable file; it stays in the backup folder */
      }
    }
    await fs.rename(dir, `${dir}.imported-${Date.now()}`)
    return n
  }
}
