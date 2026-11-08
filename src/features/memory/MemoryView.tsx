import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Database, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { MemoryHit, MemoryProgress, MemorySearchMode, MemoryStatus } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { api, errorMessage } from '@/lib/api'
import { useStore } from '@/app/store'
import { useAi } from '@/app/ai-store'
import { t as tr, useT } from '@/lib/i18n'

interface MemoryState {
  status: MemoryStatus | null
  progress: MemoryProgress | null
  hits: MemoryHit[]
  query: string
  searching: boolean
  refresh(): Promise<void>
  index(): Promise<void>
  clear(): Promise<void>
  search(q: string): Promise<void>
}

const notifyError = (err: unknown) => useStore.getState().notify('error', errorMessage(err))

export const useMemory = create<MemoryState>((set, get) => {
  api.on('memory:progress', p => set({ progress: p }))
  return {
    status: null,
    progress: null,
    hits: [],
    query: '',
    searching: false,
    async refresh() {
      if (!useStore.getState().workspace) return
      set({ status: await api.invoke('memory:status').catch(() => null) })
    },
    async index() {
      try {
        const p = await api.invoke('memory:index')
        set({ progress: p })
        if (p.error) useStore.getState().notify('error', `${tr('Indexing failed')}: ${p.error}`)
        else useStore.getState().notify('success', tr('Indexed {files} files, {chunks} new chunks in {s} s', { files: p.filesDone, chunks: p.chunksEmbedded, s: p.seconds.toFixed(0) }))
      } catch (err) {
        notifyError(err)
      }
      await get().refresh()
    },
    async clear() {
      if (!window.confirm(tr('Delete the memory index of this workspace? Source files are not touched.'))) return
      set({ status: await api.invoke('memory:clear'), hits: [] })
    },
    async search(q) {
      set({ query: q, searching: true })
      try {
        set({ hits: await api.invoke('memory:search', q, 12) })
      } catch (err) {
        notifyError(err)
      } finally {
        set({ searching: false })
      }
    },
  }
})

export function MemoryView() {
  const workspace = useStore(s => s.workspace)
  const { status, progress, hits, searching } = useMemory()
  const { refresh, index, clear, search } = useMemory.getState()
  const openFile = useStore(s => s.openFile)
  const [q, setQ] = useState('')
  const t = useT()
  const label = useAi(s => s.label)
  const settings = useAi(s => s.settings)
  const hasReranker = useAi(s => s.models.some(m => m.kind === 'reranker'))
  const setMode = async (mode: MemorySearchMode) => {
    useAi.setState({ settings: await api.invoke('settings:set-memory-search', mode) })
  }

  useEffect(() => {
    void refresh()
  }, [workspace, refresh])

  if (!workspace) {
    return (
      <div className="h-full p-2">
        <Panel title={t('MEMORY')}>
          <p className="p-4 text-muted">{t('Open a workspace first.')}</p>
        </Panel>
      </div>
    )
  }

  const running = status?.indexing || (progress && progress.phase !== 'done' && progress.phase !== 'error')
  const pct = progress?.filesTotal ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0

  return (
    <div className="grid h-full grid-cols-[320px_minmax(0,1fr)] gap-2 p-2">
      <div className="flex min-h-0 flex-col gap-2">
        <Panel
          title={t('PROJECT MEMORY')}
          fit
          actions={
            <IconButton title={t('Refresh')} onClick={() => void refresh()}>
              <RefreshCw size={12} />
            </IconButton>
          }
        >
          <div data-testid="memory-status" className="flex flex-col gap-1.5 p-3 font-mono text-[11px]">
            <Row k={t('WORKSPACE')} v={workspace.name} />
            <Row k={t('FILES')} v={String(status?.files ?? '—')} />
            <Row k="CHUNKS" v={String(status?.chunks ?? '—')} />
            <Row k={t('MODEL')} v={status?.model ? label(status.model) : `(${t('not indexed')}) ${status?.configuredModel ? label(status.configuredModel) : ''}`} />
            <Row k="DIMS" v={status?.dims ? String(status.dims) : '—'} />
            <Row k={t('INDEXED')} v={status?.indexedAt ? new Date(status.indexedAt).toLocaleString() : t('never')} />
            <div className="mt-2 flex gap-1">
              <button
                data-testid="memory-index"
                disabled={!!running}
                onClick={() => void index()}
                className="hud-cut-sm flex flex-1 items-center justify-center gap-1 bg-primary py-1 font-bold text-void disabled:bg-line disabled:text-dim"
              >
                <Database size={12} /> {status?.chunks ? t('UPDATE INDEX') : t('BUILD INDEX')}
              </button>
              <button title={t('Delete index')} disabled={!!running || !status?.chunks} onClick={() => void clear()} className="border border-critical px-2 text-critical disabled:opacity-30">
                <Trash2 size={12} />
              </button>
            </div>
            <label className="mt-1 flex items-center gap-2 text-muted" title={t('Measured on 26 questions about this project: embeddings alone ranked the right file first most often.')}>
              {t('SEARCH')}
              <select data-testid="memory-search-mode" value={settings?.memorySearch ?? 'vector'} onChange={e => void setMode(e.target.value as MemorySearchMode)} className="border border-line bg-void px-1 py-0.5 text-text outline-none">
                <option value="vector">{t('EMBEDDINGS (default)')}</option>
                <option value="hybrid">{t('HYBRID: + exact words and identifiers')}</option>
                <option value="rerank" disabled={!hasReranker}>
                  {hasReranker ? t('HYBRID + RERANKER (~1 s per search)') : t('HYBRID + RERANKER (download it in SETUP)')}
                </option>
              </select>
            </label>
            {progress && (
              <div className="mt-1 flex flex-col gap-1">
                <div className="h-1 bg-line">
                  <div className={`h-full ${progress.phase === 'error' ? 'bg-critical' : 'bg-secondary'} transition-[width]`} style={{ width: `${progress.phase === 'done' ? 100 : pct}%` }} />
                </div>
                <span className={progress.error ? 'text-critical' : 'text-muted'}>
                  {progress.phase} · {progress.filesDone}/{progress.filesTotal} {t('files')} · {progress.chunksEmbedded} {t('chunks embedded')} · {progress.seconds.toFixed(0)} s
                  {progress.error ? ` · ${progress.error}` : ''}
                </span>
              </div>
            )}
          </div>
        </Panel>
        <Panel title={t('HOW IT WORKS')} accent="secondary" className="flex-1">
          <p className="p-3 text-[11.5px] leading-relaxed text-dim">
            {t('Source files are split into 60-line chunks, embedded by the local Qwen3-Embedding model (llama.cpp) and stored in SQLite (sqlite-vec) together with a word index. Search combines meaning and exact words (function and file names); tests rank below the code unless you ask about tests. Updating re-embeds only changed files. Nothing leaves this machine.')}
          </p>
        </Panel>
      </div>

      <Panel title={`${t('SEMANTIC SEARCH')}${hits.length ? ` // ${t('{n} HITS', { n: hits.length })}` : ''}`}>
        <div className="flex h-full flex-col">
          <form
            className="flex gap-2 border-b border-line p-2"
            onSubmit={e => {
              e.preventDefault()
              if (q.trim()) void search(q.trim())
            }}
          >
            <input
              data-testid="memory-query"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('Ask in plain language, e.g. “where are paths outside the workspace rejected?”')}
              className="min-w-0 flex-1 border border-line bg-void px-2 py-1.5 text-[13px] text-text outline-none placeholder:text-dim focus:border-secondary"
            />
            <button data-testid="memory-search" disabled={!q.trim() || !status?.chunks || searching} className="hud-cut-sm flex items-center gap-1 bg-secondary px-3 font-mono text-[11px] font-bold text-void disabled:bg-line disabled:text-dim">
              <Search size={12} /> {searching ? '…' : t('SEARCH')}
            </button>
          </form>
          <ul data-testid="memory-hits" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {!status?.chunks && <li className="p-2 text-[12px] text-dim">{t('Build the index first.')}</li>}
            {hits.map((h, i) => (
              <li key={`${h.path}:${h.startLine}`} className="border border-line bg-void">
                <button
                  onClick={() => void openFile(h.path, h.startLine)}
                  className="flex w-full items-center gap-2 border-b border-line px-2 py-1 text-left font-mono text-[11px] hover:bg-surface-2"
                >
                  <span className="text-dim">#{i + 1}</span>
                  <span className="truncate text-secondary">{h.path}</span>
                  <span className="text-muted">
                    :{h.startLine}-{h.endLine}
                  </span>
                  <span className="ml-auto text-primary">{h.score.toFixed(3)}</span>
                </button>
                <pre className="max-h-40 overflow-hidden p-2 font-mono text-[11px] whitespace-pre-wrap text-muted select-text">{h.content.slice(0, 900)}</pre>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-dim">{k}</span>
      <span className="truncate text-text" title={v}>
        {v}
      </span>
    </div>
  )
}
