import { create } from 'zustand'
import type { ChatFileResult, ChatMessage, Conversation, ConversationSummary } from '../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { extractCodeFiles } from '@/components/Markdown'
import { t as tr } from '@/lib/i18n'
import { useStore } from './store'

export const DEFAULT_SYSTEM_PROMPT =
  'You are NETRUNNER, a senior software engineer assistant running fully locally on the user\'s Windows workstation. ' +
  'Answer precisely, prefer working code, and say when you are unsure. Never claim to have run code or tests you did not run. ' +
  'Reply in the language of the user\'s message (for example Russian or English); keep code, identifiers and commands as they are.'

/**
 * Added to the system prompt while a project is open: code blocks that carry a path can be written to disk
 * (NEURAL CORE → FILES decides whether that happens on its own or on SAVE).
 */
export const FILE_BLOCK_RULE =
  'A project folder is open. When you give the complete content of a file in it, start the code block with the ' +
  'language and the file path relative to the project root, for example ```ts path=src/app.ts — NETRUNNER writes ' +
  'such blocks to disk. Use path= only for the whole file; to change part of a file, give the whole updated file. ' +
  'Never use path= for excerpts, examples or shell commands.'

/** Added to the system prompt when WEB is on: the model has tools for the internet and for repositories. */
export const WEB_RULE =
  'You have web tools: web_search, fetch_url (read a page), repo_clone / repo_list / repo_read / repo_install / repo_run ' +
  '(download a git repository into the NETRUNNER repos folder, look into it, install it, run commands in it). ' +
  'Use them whenever the answer depends on current or external information, a library, an API or a repository: search, ' +
  'read the best sources (not only snippets), and base the answer on what you read. Name the URLs you used. ' +
  'What you remember about versions, releases, prices, news, people and dates is out of date: for such questions call ' +
  'web_search or fetch_url before answering and never answer them from memory. ' +
  'To work with a repository, clone it, read its README and key files, then install or run it if asked. ' +
  'If a tool fails or the operator declines it, say so instead of guessing.'

export interface SendOptions {
  think: boolean | null
  contextLength: number | null
  attachActiveFile: boolean
  useMemory: boolean
  /** Pictures for a vision model, as data URLs. */
  images?: string[]
  /** WEB: the model may use the web tools while it answers. */
  web?: boolean
}

/** Closest project chunks from the local semantic index, as a prompt prefix ('' when unavailable). */
async function memoryContext(query: string): Promise<string> {
  try {
    const hits = await api.invoke('memory:search', query, 6)
    if (!hits.length) return ''
    let out = 'Relevant code from the project memory (local semantic search):\n'
    for (const h of hits) {
      const block = `\n--- ${h.path} (lines ${h.startLine}-${h.endLine})\n${h.content}\n`
      if (out.length + block.length > 10000) break
      out += block
    }
    return `${out}\n---\n\n`
  } catch {
    return ''
  }
}

interface ChatState {
  list: ConversationSummary[]
  current: Conversation | null
  streamId: string | null

  loadList(): Promise<void>
  open(id: string): Promise<void>
  newChat(model: string): void
  setModel(model: string): void
  setSystemPrompt(prompt: string): void
  send(text: string, opts: SendOptions): Promise<void>
  stop(): Promise<void>
  remove(id: string): Promise<void>
  /** SAVE: write the files of an answer (all, or one path) as the user asked; the mode decides what is confirmed. */
  saveFiles(index: number, path?: string): Promise<void>
  /** UNDO: put back what the chat overwrote and remove what it created (to the recycle bin). */
  undoFiles(index: number, path?: string): Promise<void>
}

const notifyError = (err: unknown) => useStore.getState().notify('error', errorMessage(err))

function attachment(): string {
  const { tabs, activePath } = useStore.getState()
  const tab = tabs.find(t => t.path === activePath)
  if (!tab) return ''
  return `Active file \`${tab.path}\`:\n\`\`\`${tab.language}\n${tab.content}\n\`\`\`\n\n`
}

export const useChat = create<ChatState>((set, get) => {
  const persist = async () => {
    const c = get().current
    if (!c || c.messages.length === 0) return
    try {
      await api.invoke('conversations:save', c)
      await get().loadList()
    } catch (err) {
      notifyError(err)
    }
  }

  /** Merge write results into message `index` (by path) and store the conversation. */
  const recordFiles = async (id: string, index: number, results: ChatFileResult[]) => {
    set(s => {
      if (!s.current || s.current.id !== id || !s.current.messages[index]) return {}
      const messages = [...s.current.messages]
      const files = [...(messages[index].files ?? [])]
      for (const r of results) {
        const at = files.findIndex(f => f.path === r.path)
        if (at >= 0) files[at] = r
        else files.push(r)
      }
      messages[index] = { ...messages[index], files }
      return { current: { ...s.current, messages } }
    })
    await persist()
    const written = results.filter(r => r.status === 'created' || r.status === 'overwritten')
    const failed = results.filter(r => r.status === 'error')
    if (written.length) useStore.getState().notify('info', tr('Written: {files}', { files: written.map(r => r.path).join(', ') }))
    if (failed.length) useStore.getState().notify('error', failed.map(r => `${r.path}: ${r.error}`).join('; '))
  }

  const writeFiles = async (index: number, trigger: 'auto' | 'manual', path?: string) => {
    const c = get().current
    const msg = c?.messages[index]
    if (!c || !msg || msg.role !== 'assistant' || !useStore.getState().workspace) return
    const files = extractCodeFiles(msg.content).filter(f => !path || f.path === path)
    if (!files.length) return
    try {
      await recordFiles(c.id, index, await api.invoke('chat:write-files', files, trigger))
    } catch (err) {
      notifyError(err)
    }
  }

  api.on('chat:chunk', chunk => {
    if (chunk.streamId !== get().streamId) return
    set(s => {
      if (!s.current) return {}
      const messages = [...s.current.messages]
      const last = { ...messages[messages.length - 1] }
      last.content += chunk.content
      if (chunk.thinking) last.thinking = (last.thinking ?? '') + chunk.thinking
      if (chunk.servedModel && chunk.servedModel !== s.current.model) last.model = chunk.servedModel
      if (chunk.tool) {
        const tools = [...(last.tools ?? [])]
        const at = tools.findIndex(x => x.id === chunk.tool!.id)
        if (at >= 0) tools[at] = chunk.tool
        else tools.push(chunk.tool)
        last.tools = tools
      }
      if (chunk.done) {
        last.metrics = chunk.metrics
        last.error = chunk.error
      }
      messages[messages.length - 1] = last
      return {
        current: { ...s.current, messages, updatedAt: new Date().toISOString() },
        streamId: chunk.done ? null : s.streamId,
      }
    })
    if (chunk.done) {
      const c = get().current
      // A finished answer: its file blocks are written as far as the FILES mode allows.
      if (c && !chunk.error) void persist().then(() => writeFiles(c.messages.length - 1, 'auto'))
      else void persist()
    }
  })

  return {
    list: [],
    current: null,
    streamId: null,

    async loadList() {
      set({ list: await api.invoke('conversations:list') })
    },

    async open(id) {
      if (get().streamId) return
      try {
        set({ current: await api.invoke('conversations:get', id) })
      } catch (err) {
        notifyError(err)
      }
    },

    newChat(model) {
      if (get().streamId) return
      const now = new Date().toISOString()
      set({
        current: {
          id: crypto.randomUUID(),
          title: 'New session',
          model,
          createdAt: now,
          updatedAt: now,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          messages: [],
        },
      })
    },

    setModel(model) {
      set(s => (s.current ? { current: { ...s.current, model } } : {}))
    },

    setSystemPrompt(systemPrompt) {
      set(s => (s.current ? { current: { ...s.current, systemPrompt } } : {}))
    },

    async send(text, opts) {
      const c = get().current
      const images = opts.images?.length ? opts.images : undefined
      if (!c || get().streamId || (!text.trim() && !images)) return
      const content = (opts.useMemory ? await memoryContext(text.trim()) : '') + (opts.attachActiveFile ? attachment() : '') + text.trim()
      const system = [c.systemPrompt.trim(), useStore.getState().workspace ? FILE_BLOCK_RULE : '', opts.web ? WEB_RULE : ''].filter(Boolean).join('\n\n')
      const history: ChatMessage[] = [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        ...c.messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
        { role: 'user', content, ...(images ? { images } : {}) },
      ]
      set({
        current: {
          ...c,
          title: c.messages.length === 0 ? (text.trim() || 'Image').slice(0, 60) : c.title,
          messages: [...c.messages, { role: 'user', content, ...(images ? { images } : {}) }, { role: 'assistant', content: '', thinking: '' }],
        },
      })
      try {
        const streamId = await api.invoke('chat:start', {
          model: c.model,
          messages: history,
          think: opts.think,
          contextLength: opts.contextLength,
          temperature: null,
          web: opts.web === true,
        })
        set({ streamId })
      } catch (err) {
        set(s => {
          if (!s.current) return {}
          const messages = [...s.current.messages]
          messages[messages.length - 1] = { ...messages[messages.length - 1], error: errorMessage(err) }
          return { current: { ...s.current, messages } }
        })
      }
    },

    async stop() {
      const id = get().streamId
      if (id) await api.invoke('chat:stop', id)
    },

    saveFiles: (index, path) => writeFiles(index, 'manual', path),

    async undoFiles(index, path) {
      const c = get().current
      const msg = c?.messages[index]
      // What this answer wrote: undo only runs while the file still holds it.
      const wrote = new Map(extractCodeFiles(msg?.content ?? '').map(f => [f.path, f.content]))
      const writes = (msg?.files ?? [])
        .filter(f => (f.status === 'created' || f.status === 'overwritten') && (!path || f.path === path) && wrote.has(f.path))
        .map(f => ({ path: f.path, previous: f.previous, expected: wrote.get(f.path) ?? '' }))
      if (!c || !writes.length) return
      try {
        await recordFiles(c.id, index, await api.invoke('chat:undo-files', writes))
      } catch (err) {
        notifyError(err)
      }
    },

    async remove(id) {
      await api.invoke('conversations:delete', id)
      if (get().current?.id === id) set({ current: null })
      await get().loadList()
    },
  }
})
