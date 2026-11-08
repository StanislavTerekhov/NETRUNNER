import { useEffect, useRef, useState } from 'react'
import { Download, FileCode2, Globe, ImagePlus, MessageSquarePlus, Send, Square, Trash2, X } from 'lucide-react'
import type { ChatFileWrites, ConversationSummary } from '../../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { imageToDataUrl } from '@/lib/image'
import { Panel, IconButton } from '@/components/hud/Panel'
import { useAi } from '@/app/ai-store'
import { useChat } from '@/app/chat-store'
import { useStore } from '@/app/store'
import { MessageView } from './MessageView'
import { t as tr, useT } from '@/lib/i18n'

const CONTEXT_OPTIONS = [4096, 8192, 16384, 32768, 65536]

export function NeuralCore() {
  const refresh = useAi(s => s.refresh)
  const loadList = useChat(s => s.loadList)
  useEffect(() => {
    void refresh()
    void loadList()
  }, [refresh, loadList])

  return (
    <div className="grid h-full grid-cols-[240px_minmax(0,1fr)] gap-2 p-2">
      <SessionList />
      <ChatPanel />
    </div>
  )
}

/** The chat alone, for a layout that docks it beside the editor (sessions stay in NEURAL CORE). */
export function ChatDock() {
  const refresh = useAi(s => s.refresh)
  const loadList = useChat(s => s.loadList)
  useEffect(() => {
    void refresh()
    void loadList()
  }, [refresh, loadList])
  return <ChatPanel />
}

function SessionList() {
  const all = useChat(s => s.list)
  const current = useChat(s => s.current)
  const streaming = useChat(s => !!s.streamId)
  const { open, remove, newChat } = useChat.getState()
  const defaultModel = useAi(s => s.roles.general)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<(ConversationSummary & { snippet: string })[] | null>(null)
  useEffect(() => {
    if (!query.trim()) return setFound(null)
    const timer = setTimeout(() => void api.invoke('conversations:search', query).then(setFound, () => setFound([])), 200)
    return () => clearTimeout(timer)
  }, [query, all])
  const list = found ?? all
  const t = useT()
  const exportChat = async (id: string, format: 'md' | 'json') => {
    try {
      const file = await api.invoke('conversations:export', id, format)
      if (file) useStore.getState().notify('success', `${tr('Exported to')} ${file}`)
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    }
  }

  return (
    <Panel
      title={t('SESSIONS')}
      accent="secondary"
      actions={
        <IconButton title={t('New session')} disabled={!defaultModel || streaming} onClick={() => defaultModel && newChat(defaultModel)}>
          <MessageSquarePlus size={13} />
        </IconButton>
      }
    >
      <div className="flex h-full flex-col">
      <div className="border-b border-line p-2">
        <input
          data-testid="chat-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('search chats…')}
          className="w-full border border-line bg-void px-2 py-1 font-mono text-[11.5px] text-text outline-none placeholder:text-dim focus:border-secondary"
        />
      </div>
      <ul data-testid="chat-sessions" className="min-h-0 flex-1 overflow-auto py-1">
        {list.length === 0 && <li className="px-3 py-2 text-[12px] text-dim">{found ? t('Nothing found.') : t('No saved sessions.')}</li>}
        {list.map(c => (
          <li key={c.id} className="group flex items-center">
            <button
              data-session={c.id}
              onClick={() => void open(c.id)}
              className={`min-w-0 flex-1 px-3 py-1.5 text-left ${current?.id === c.id ? 'bg-secondary/10 text-secondary' : 'text-text hover:bg-surface-2'}`}
            >
              <div className="truncate text-[12.5px]">{c.title}</div>
              <div className="truncate font-mono text-[10px] text-dim">
                {useAi.getState().label(c.model)} · {c.messageCount} {t('msg')}
              </div>
              {'snippet' in c && <div className="truncate text-[10.5px] text-muted">{(c as { snippet: string }).snippet}</div>}
            </button>
            <button title={t('Export as Markdown')} onClick={() => void exportChat(c.id, 'md')} className="hidden px-1 text-dim group-hover:block hover:text-secondary">
              <Download size={12} />
            </button>
            <button
              title={t('Delete session')}
              onClick={() => window.confirm(t('Delete "{title}"?', { title: c.title })) && void remove(c.id)}
              className="hidden px-2 text-dim group-hover:block hover:text-critical"
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      </div>
    </Panel>
  )
}

function ChatPanel() {
  const current = useChat(s => s.current)
  const streamId = useChat(s => s.streamId)
  const { send, stop, setModel, setSystemPrompt, newChat } = useChat.getState()
  const allModels = useAi(s => s.models)
  const models = allModels.filter(m => m.kind === 'chat')
  const label = useAi(s => s.label)
  const status = useAi(s => s.status)
  const defaultModel = useAi(s => s.roles.general)
  const details = useAi(s => (current ? s.details[current.model] : undefined))
  const fileWrites = useAi(s => s.settings?.chatFileWrites ?? 'limited')
  const setFileWrites = async (mode: ChatFileWrites) => {
    try {
      useAi.setState({ settings: await api.invoke('settings:set-chat-file-writes', mode) })
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    }
  }
  const activePath = useStore(s => s.activePath)
  const t = useT()

  const [text, setText] = useState('')
  const [think, setThink] = useState(false)
  const [ctx, setCtx] = useState(16384)
  const [attach, setAttach] = useState(false)
  const [useMemory, setUseMemory] = useState(false)
  const [web, setWeb] = useState(false)
  const online = useAi(s => s.settings?.networkMode === 'online-tools')
  const [showSystem, setShowSystem] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!current && defaultModel) newChat(defaultModel)
  }, [current, defaultModel, newChat])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.messages])

  const canThink = details?.capabilities.includes('thinking') ?? false
  const canSee = details?.capabilities.includes('vision') ?? false
  const maxCtx = details?.contextLength ?? null
  const [images, setImages] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const addImages = async (files: Blob[]) => {
    const pics = files.filter(f => f.type.startsWith('image/'))
    if (!pics.length) return
    if (!canSee) {
      useStore.getState().notify('error', tr('{model} cannot see images — pick a model with a vision projector (e.g. Qwen3.8-27B)', { model: label(current?.model) }))
      return
    }
    try {
      const urls = await Promise.all(pics.map(f => imageToDataUrl(f)))
      setImages(cur => [...cur, ...urls].slice(0, 4))
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    }
  }
  const submit = () => {
    if (!text.trim() && !images.length) return
    void send(text, { think: canThink ? think : null, contextLength: ctx, attachActiveFile: attach, useMemory, images, web: web && online })
    setText('')
    setImages([])
  }

  if (!status?.reachable) {
    return (
      <Panel title="NEURAL CORE">
        <div className="flex h-full items-center justify-center p-6 text-center text-muted">
          {status ? `${t('Local runtime not available')}: ${status.error} — ${t('see MODEL VAULT → SETUP')}` : t('Checking the llama.cpp runtime…')}
        </div>
      </Panel>
    )
  }
  if (models.length === 0 || !current) {
    return (
      <Panel title="NEURAL CORE">
        <div className="flex h-full items-center justify-center text-muted">{t('No local models installed — open MODEL VAULT.')}</div>
      </Panel>
    )
  }

  return (
    <Panel title={`NEURAL CORE // ${current.title.toUpperCase()}`}>
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 font-mono text-[11px]">
          <label className="flex items-center gap-1 text-muted">
            {t('MODEL')}
            <select
              data-testid="chat-model"
              value={current.model}
              disabled={!!streamId}
              onChange={e => setModel(e.target.value)}
              className="border border-line bg-void px-1 py-0.5 text-text outline-none"
            >
              {models.map(m => (
                <option key={m.name} value={m.name}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-muted">
            CTX
            <select value={ctx} onChange={e => setCtx(Number(e.target.value))} className="border border-line bg-void px-1 py-0.5 text-text outline-none">
              {CONTEXT_OPTIONS.filter(c => !maxCtx || c <= maxCtx).map(c => (
                <option key={c} value={c}>
                  {c / 1024}K
                </option>
              ))}
            </select>
          </label>
          <Toggle on={canThink && think} disabled={!canThink} onClick={() => setThink(t => !t)} label={t('THINK')} title={canThink ? t('Reasoning mode') : t('Model has no thinking capability')} />
          <Toggle
            on={attach && !!activePath}
            disabled={!activePath}
            onClick={() => setAttach(a => !a)}
            label={<><FileCode2 size={11} /> {t('ACTIVE FILE')}</>}
            title={activePath ? `${t('Attach')} ${activePath}` : t('Open a file in the editor to attach it')}
          />
          <Toggle on={useMemory} onClick={() => setUseMemory(m => !m)} label={t('MEMORY')} title={t('Attach the closest code from the project memory index')} />
          <span data-testid="chat-web" className="contents">
            <Toggle
              on={web && online}
              disabled={!online}
              onClick={() => setWeb(w => !w)}
              label={<><Globe size={11} /> WEB</>}
              title={online ? t('The model may search the internet, read pages and download, install and run repositories (NETWORK → WEB TOOLS)') : t('Needs ONLINE TOOLS network mode')}
            />
          </span>
          <Toggle on={showSystem} onClick={() => setShowSystem(s => !s)} label={t('SYSTEM')} title={t('Edit system prompt')} />
          <label className="flex items-center gap-1 text-muted" title={t('Code blocks with a file path: ASK — only on SAVE, confirmed each time; LIMITED — new files are created at once, overwriting is confirmed; FULL — everything is written at once. UNDO under the block reverts.')}>
            {t('FILES')}
            <select data-testid="chat-file-writes" value={fileWrites} onChange={e => void setFileWrites(e.target.value as ChatFileWrites)} className="border border-line bg-void px-1 py-0.5 text-text outline-none">
              <option value="ask">{t('ASK')}</option>
              <option value="limited">{t('LIMITED')}</option>
              <option value="full">{t('FULL')}</option>
            </select>
          </label>
          <span className="ml-auto text-success">{t('LOCAL INFERENCE')} · llama.cpp {status.version}</span>
        </div>
        {showSystem && (
          <textarea
            value={current.systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            className="h-24 shrink-0 resize-none border-b border-line bg-void p-2 font-mono text-[11.5px] text-text outline-none select-text"
          />
        )}

        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {current.messages.length === 0 && (
            <div className="m-auto text-center font-mono text-[12px] text-dim">
              {label(current.model)} · {t('loads on first message (large models take a while) · all computation stays on this machine')}
            </div>
          )}
          {current.messages.map((m, i) => (
            <MessageView key={i} index={i} message={m} streaming={!!streamId && i === current.messages.length - 1} />
          ))}
        </div>

        {images.length > 0 && (
          <div data-testid="chat-attachments" className="flex gap-2 border-t border-line px-2 pt-2">
            {images.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt={`${t('attachment')} ${i + 1}`} className="h-16 w-16 border border-line object-cover" />
                <button
                  aria-label={t('Remove image')}
                  onClick={() => setImages(cur => cur.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 bg-critical p-0.5 text-void"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="flex gap-2 border-t border-line p-2"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault()
            void addImages([...e.dataTransfer.files])
          }}
        >
          <input
            ref={fileInput}
            data-testid="chat-image-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={e => {
              void addImages([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <button
            data-testid="chat-attach-image"
            title={canSee ? t('Attach images (or paste / drop them)') : t('This model has no vision projector')}
            disabled={!canSee || !!streamId}
            onClick={() => fileInput.current?.click()}
            className="flex w-9 items-center justify-center border border-line text-muted hover:text-secondary disabled:opacity-40"
          >
            <ImagePlus size={15} />
          </button>
          <textarea
            data-testid="chat-input"
            value={text}
            onPaste={e => {
              const files = [...e.clipboardData.files]
              if (files.some(f => f.type.startsWith('image/'))) {
                e.preventDefault()
                void addImages(files)
              }
            }}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={t('Message the local model (Enter to send, Shift+Enter for newline)')}
            rows={3}
            className="min-w-0 flex-1 resize-none border border-line bg-void p-2 text-[13px] text-text outline-none select-text placeholder:text-dim focus:border-secondary"
          />
          {streamId ? (
            <button onClick={() => void stop()} className="hud-cut-sm flex w-20 flex-col items-center justify-center gap-1 bg-critical font-mono text-[10px] font-bold text-void">
              <Square size={14} /> {t('STOP')}
            </button>
          ) : (
            <button
              data-testid="chat-send"
              onClick={submit}
              disabled={!text.trim() && !images.length}
              className="hud-cut-sm flex w-20 flex-col items-center justify-center gap-1 bg-primary font-mono text-[10px] font-bold text-void disabled:bg-line disabled:text-dim"
            >
              <Send size={14} /> {t('SEND')}
            </button>
          )}
        </div>
      </div>
    </Panel>
  )
}

function Toggle(props: { on: boolean; disabled?: boolean; onClick: () => void; label: React.ReactNode; title: string }) {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex items-center gap-1 border px-1.5 py-0.5 ${
        props.on ? 'border-primary text-primary' : 'border-line text-muted hover:text-text'
      } disabled:opacity-40`}
    >
      {props.label}
    </button>
  )
}
