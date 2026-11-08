import { useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { X } from 'lucide-react'
import { monaco } from './monaco-setup'
import { resetLsp, syncLsp } from './lsp-client'
import { isDirty, useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

export function EditorArea() {
  const tabs = useStore(s => s.tabs)
  const activePath = useStore(s => s.activePath)
  const setActive = useStore(s => s.setActive)
  const closeTab = useStore(s => s.closeTab)
  const updateContent = useStore(s => s.updateContent)
  const active = tabs.find(t => t.path === activePath) ?? null
  const tr = useT()

  const reveal = useStore(s => s.reveal)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  useEffect(() => {
    const ed = editorRef.current
    if (!reveal || !ed || reveal.path !== activePath) return
    // Wait one frame so the model of the newly active tab is attached.
    requestAnimationFrame(() => {
      ed.revealLineInCenter(reveal.line)
      ed.setPosition({ lineNumber: reveal.line, column: 1 })
      ed.focus()
      useStore.setState({ reveal: null })
    })
  }, [reveal, activePath])

  // Dispose models of closed tabs so reopening a file shows its current content from disk; a tab reloaded from
  // disk (changed by an agent or another tool) pushes its new text into its model. Typing keeps both equal.
  useEffect(() => {
    const open = new Set(tabs.map(t => monaco.Uri.parse(t.path).toString()))
    for (const model of monaco.editor.getModels()) {
      if (!open.has(model.uri.toString())) model.dispose()
    }
    for (const t of tabs) {
      const model = monaco.editor.getModel(monaco.Uri.parse(t.path))
      // setValue re-detects the line endings from the new text; an edit operation would convert it to the model's EOL
      // (CRLF for a new empty file on Windows) and leave the tab looking modified.
      if (model && model.getValue() !== t.content) model.setValue(t.content)
    }
    // Models exist once Monaco mounted the tab; wait a frame so new tabs are included.
    requestAnimationFrame(() => syncLsp(useStore.getState().tabs))
  }, [tabs])
  const workspaceRoot = useStore(s => s.workspace?.root)
  useEffect(() => resetLsp(), [workspaceRoot])
  const reloadTab = useStore(s => s.reloadTab)
  const t = useT()

  return (
    <section className="hud-panel flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-end overflow-x-auto border-b border-line bg-void/40" aria-label={tr('Open files')}>
        {tabs.map(t => {
          const selected = t.path === activePath
          return (
            // Each open file is a button (the active one marked aria-current) with its close button beside it.
            <div
              key={t.path}
              data-tab={t.path}
              onClick={() => setActive(t.path)}
              onAuxClick={e => e.button === 1 && closeTab(t.path)}
              title={t.path}
              className={`group flex h-full max-w-56 cursor-pointer items-center gap-2 border-r border-line px-3 text-[12px] ${
                selected ? 'border-t-2 border-t-primary bg-surface text-text' : 'border-t-2 border-t-transparent text-muted hover:text-text'
              }`}
            >
              <button aria-current={selected ? 'page' : undefined} className="truncate outline-none focus-visible:underline">
                {t.path.split('/').pop()}
              </button>
              <button
                aria-label={`${tr('Close')} ${t.path}`}
                onClick={e => {
                  e.stopPropagation()
                  closeTab(t.path)
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center"
              >
                {isDirty(t) ? (
                  <span className="h-2 w-2 bg-primary group-hover:hidden" />
                ) : null}
                <X size={12} className={isDirty(t) ? 'hidden group-hover:block' : 'opacity-0 group-hover:opacity-100'} />
              </button>
            </div>
          )
        })}
      </div>

      {active?.disk && (
        <div data-testid="disk-banner" className="flex items-center gap-3 border-b border-critical/40 bg-critical/10 px-3 py-1 font-mono text-[11px] text-critical">
          {active.disk === 'deleted' ? t('This file was deleted on disk. Saving recreates it.') : t('Changed on disk while you have unsaved edits.')}
          {active.disk === 'changed' && (
            <button onClick={() => void reloadTab(active.path)} className="border border-critical px-2 hover:bg-critical/20">
              {t('RELOAD FROM DISK (discard my edits)')}
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {active ? (
          <Editor
            key="main-editor"
            path={active.path}
            language={active.language}
            defaultValue={active.content}
            theme="netrunner"
            onMount={ed => {
              editorRef.current = ed
              ed.onDidChangeModel(() => syncLsp(useStore.getState().tabs))
              useStore.setState(s => ({ reveal: s.reveal ? { ...s.reveal } : null })) // re-run reveal for the first open
            }}
            onChange={value => updateContent(active.path, value ?? '')}
            options={{
              fontFamily: "'Cascadia Code', Consolas, monospace",
              fontSize: 13.5,
              fontLigatures: true,
              minimap: { enabled: true, renderCharacters: false },
              smoothScrolling: true,
              cursorBlinking: 'phase',
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              padding: { top: 8 },
            }}
          />
        ) : (
          <EmptyEditor />
        )}
      </div>
    </section>
  )
}

function EmptyEditor() {
  const t = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 font-mono text-muted">
      <div className="text-[28px] font-bold tracking-[0.4em] text-line-bright">NETRUNNER</div>
      <div className="text-[11px] text-dim">{t('Select a file in the explorer · Ctrl+O open folder · Ctrl+Shift+P commands')}</div>
    </div>
  )
}
