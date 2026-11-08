import { useState } from 'react'
import { BrainCircuit, ChevronDown, ChevronRight, Copy, FileText, FolderTree, GitBranch, Globe, Package, Save, Search, TerminalSquare, Undo2 } from 'lucide-react'
import type { ChatFileResult, ChatMetrics, ChatToolStep, Conversation } from '../../../electron/shared/ipc'
import { Markdown } from '@/components/Markdown'
import { looksPartial } from '@/lib/code-files'
import { useT } from '@/lib/i18n'
import { useAi } from '@/app/ai-store'
import { useChat } from '@/app/chat-store'
import { useStore } from '@/app/store'

type Message = Conversation['messages'][number]

/** Splits text on ``` fences. Deliberately minimal: no HTML is ever injected. */
function segments(text: string): { code: boolean; lang: string; body: string }[] {
  const out: { code: boolean; lang: string; body: string }[] = []
  const re = /```([\w+-]*)\n?([\s\S]*?)(```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, lang: '', body: text.slice(last, m.index) })
    out.push({ code: true, lang: m[1], body: m[2] })
    last = re.lastIndex
    if (m[0].length === 0) break
  }
  if (last < text.length) out.push({ code: false, lang: '', body: text.slice(last) })
  return out
}

export function MessageView({ message, streaming, index }: { message: Message; streaming: boolean; index: number }) {
  const isUser = message.role === 'user'
  const t = useT()
  return (
    <div data-role={message.role} className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <span className={`font-mono text-[10px] tracking-[0.2em] ${isUser ? 'text-secondary' : 'text-primary'}`}>
        {isUser ? t('OPERATOR') : 'NEURAL CORE'}
      </span>
      <div
        className={`hud-cut-sm max-w-[92%] px-3 py-2 text-[13px] leading-relaxed select-text ${
          isUser ? 'border border-secondary/30 bg-secondary/5' : 'border border-line bg-surface-2'
        }`}
      >
        {message.thinking ? <Thinking text={message.thinking} live={streaming && !message.content} /> : null}
        {message.tools?.length ? <ToolSteps steps={message.tools} /> : null}
        {message.images?.length ? (
          <div data-testid="message-images" className="mb-2 flex flex-wrap gap-2">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`${t('attached image')} ${i + 1}`} className="max-h-48 max-w-full border border-line object-contain" />
            ))}
          </div>
        ) : null}
        {isUser ? (
          segments(message.content).map((s, i) =>
            s.code ? <CodeBlock key={i} lang={s.lang} code={s.body} /> : <p key={i} className="whitespace-pre-wrap">{s.body}</p>,
          )
        ) : (
          <Markdown
            text={message.content}
            renderCode={(lang, code, key, path) => (
              <CodeBlock key={key} lang={lang} code={code} file={path && !streaming ? { path, index, result: message.files?.find(f => f.path === path) } : undefined} />
            )}
          />
        )}
        {streaming && <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-primary" />}
        {message.error && message.error !== 'stopped' && (
          <p className="mt-1 font-mono text-[11.5px] text-critical">{t('ERROR')}: {message.error}</p>
        )}
        {message.error === 'stopped' && <p className="mt-1 font-mono text-[11px] text-dim">[{t('stopped by operator')}]</p>}
      </div>
      {message.model && (
        <span data-testid="served-by" className="font-mono text-[10.5px] text-secondary">
          {t('answered by {model} — the agent model, already loaded while agents run', { model: useAi.getState().label(message.model) })}
        </span>
      )}
      {message.metrics && <Metrics m={message.metrics} />}
    </div>
  )
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  fetch_url: Globe,
  repo_clone: GitBranch,
  repo_list: FolderTree,
  repo_read: FileText,
  repo_install: Package,
  repo_run: TerminalSquare,
}

/** What a tool call was about, from its arguments: the query, URL, repository, file or command. */
function toolSubject(step: ChatToolStep): string {
  try {
    const a = JSON.parse(step.args || '{}') as Record<string, unknown>
    const parts = [a.query, a.url, a.repo, a.path, a.command].filter((v): v is string => typeof v === 'string' && !!v)
    return parts.join(' · ')
  } catch {
    return step.args
  }
}

/** The tool calls of an answer, in order; each one opens to show what the tool returned. */
function ToolSteps({ steps }: { steps: ChatToolStep[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const t = useT()
  return (
    <div className="mb-2 flex flex-col gap-0.5 border-l-2 border-secondary/40 pl-2">
      {steps.map(s => {
        const Icon = TOOL_ICONS[s.name] ?? TerminalSquare
        return (
          <div key={s.id} data-testid="tool-step" data-tool={s.name} data-status={s.status}>
            <button onClick={() => setOpen(o => (o === s.id ? null : s.id))} className="flex max-w-full items-center gap-1.5 font-mono text-[11px] text-muted hover:text-text">
              <Icon size={11} className={s.status === 'error' ? 'text-critical' : s.status === 'running' ? 'animate-pulse text-primary' : 'text-secondary'} />
              <span className="text-text">{s.name}</span>
              <span className="truncate">{toolSubject(s)}</span>
              {s.status === 'running' && <span className="text-primary">{t('working…')}</span>}
            </button>
            {open === s.id && s.result && <pre className="mt-1 max-h-64 overflow-auto bg-void p-2 font-mono text-[11px] whitespace-pre-wrap text-dim">{s.result}</pre>}
          </div>
        )
      })}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <div className="mb-2 border-l-2 border-dim pl-2">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 font-mono text-[11px] text-muted hover:text-text">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <BrainCircuit size={12} />
        {live ? t('reasoning…') : t('reasoning ({n} chars)', { n: text.length.toLocaleString() })}
      </button>
      {open && <p className="mt-1 text-[12px] whitespace-pre-wrap text-dim">{text}</p>}
    </div>
  )
}

const FILE_STATUS: Record<ChatFileResult['status'], { label: string; cls: string }> = {
  created: { label: 'CREATED', cls: 'text-success' },
  overwritten: { label: 'SAVED', cls: 'text-success' },
  unchanged: { label: 'UP TO DATE', cls: 'text-muted' },
  pending: { label: 'NOT SAVED', cls: 'text-primary' },
  undone: { label: 'UNDONE', cls: 'text-muted' },
  error: { label: 'ERROR', cls: 'text-critical' },
}

/** A code block; one that names a file shows where it goes, whether it was written, and SAVE / UNDO. */
function CodeBlock({ lang, code, file }: { lang: string; code: string; file?: { path: string; index: number; result?: ChatFileResult } }) {
  const t = useT()
  const hasWorkspace = useStore(s => !!s.workspace)
  const status = file?.result?.status
  const written = status === 'created' || status === 'overwritten'
  return (
    <div data-file-block={file?.path} data-file-status={status ?? ''} className="my-2 border border-line bg-void">
      <div className="flex items-center gap-2 border-b border-line px-2 py-0.5 font-mono text-[10.5px] text-dim">
        <span>{lang || 'code'}</span>
        {file && <span className="truncate text-secondary">{file.path}</span>}
        {file && looksPartial(code) && <span className="text-primary" title={t('Looks like an excerpt: never written automatically')}>{t('EXCERPT')}</span>}
        {status && (
          <span className={FILE_STATUS[status].cls} title={file?.result?.error ?? ''}>
            {t(FILE_STATUS[status].label)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {file && hasWorkspace && !written && status !== 'unchanged' && (
            <button data-testid="file-save" title={t('Write this block to {path}', { path: file.path })} onClick={() => void useChat.getState().saveFiles(file.index, file.path)} className="flex items-center gap-1 hover:text-secondary">
              <Save size={11} /> {t('SAVE')}
            </button>
          )}
          {file && written && (
            <button data-testid="file-undo" title={t('Restore the previous content (a new file goes to the recycle bin)')} onClick={() => void useChat.getState().undoFiles(file.index, file.path)} className="flex items-center gap-1 hover:text-secondary">
              <Undo2 size={11} /> {t('UNDO')}
            </button>
          )}
          <button title={t('Copy')} onClick={() => void navigator.clipboard.writeText(code)} className="hover:text-secondary">
            <Copy size={11} />
          </button>
        </span>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[12px] text-text">{code}</pre>
    </div>
  )
}

function Metrics({ m }: { m: ChatMetrics }) {
  return (
    <span data-testid="chat-metrics" className="font-mono text-[10.5px] text-dim">
      {m.tokensPerSecond.toFixed(1)} tok/s · {m.outputTokens} out · {m.promptTokens} prompt · prompt {Math.round(m.promptMs)} ms
      {m.loadMs > 50 ? ` · load ${(m.loadMs / 1000).toFixed(1)} s` : ''} · total {(m.totalMs / 1000).toFixed(1)} s
    </span>
  )
}
