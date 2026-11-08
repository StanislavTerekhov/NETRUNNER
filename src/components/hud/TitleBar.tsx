import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X, Command as CommandIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { isDirty, useStore } from '@/app/store'
import { LayoutMenu } from './LayoutMenu'
import { useLang, useT } from '@/lib/i18n'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [focused, setFocused] = useState(true)
  const workspace = useStore(s => s.workspace)
  const activePath = useStore(s => s.activePath)
  const setPaletteOpen = useStore(s => s.setPaletteOpen)
  const t = useT()
  const lang = useLang(s => s.lang)
  const setLang = useLang(s => s.set)

  useEffect(() => {
    void api.invoke('window:get-state').then(st => {
      setMaximized(st.maximized)
      setFocused(st.focused)
    })
    return api.on('window:state', st => {
      setMaximized(st.maximized)
      setFocused(st.focused)
    })
  }, [])

  const close = () => {
    const dirty = useStore.getState().tabs.filter(isDirty)
    if (dirty.length && !window.confirm(t('{n} file(s) have unsaved changes. Quit anyway?', { n: dirty.length }))) return
    void api.invoke('window:close')
  }

  return (
    <header
      data-testid="titlebar"
      className="drag-region hud-scanlines flex h-9 shrink-0 items-center border-b border-line bg-void"
      onDoubleClick={() => void api.invoke('window:toggle-maximize')}
    >
      <div className="flex items-center gap-2 pl-3 pr-4">
        <img src="./mark.png" alt="" width={18} height={18} draggable={false} data-testid="app-mark" className={focused ? '' : 'opacity-50 grayscale'} />
        <span className={`font-mono text-[12px] font-bold tracking-[0.3em] ${focused ? 'text-primary' : 'text-dim'}`}>
          NETRUNNER
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] text-muted">
        <span className="text-dim">//</span>
        <span className="truncate">{workspace ? workspace.name : t('no workspace')}</span>
        {activePath && (
          <>
            <span className="text-dim">/</span>
            <span className="truncate text-text">{activePath}</span>
          </>
        )}
      </div>

      <button
        data-testid="language-toggle"
        title={t('Interface language')}
        onClick={() => void setLang(lang === 'ru' ? 'en' : 'ru')}
        onDoubleClick={e => e.stopPropagation()}
        className="no-drag hud-cut-sm mr-2 flex h-6 items-center gap-1 border border-line bg-surface px-2 font-mono text-[11px] text-muted hover:border-secondary hover:text-secondary"
      >
        <span className={lang === 'ru' ? 'text-primary' : ''}>RU</span>
        <span className="text-dim">/</span>
        <span className={lang === 'en' ? 'text-primary' : ''}>EN</span>
      </button>
      <LayoutMenu />
      <button
        className="no-drag hud-cut-sm mr-3 flex h-6 items-center gap-2 border border-line bg-surface px-3 font-mono text-[11px] text-muted hover:border-secondary hover:text-secondary"
        onClick={() => setPaletteOpen(true)}
        onDoubleClick={e => e.stopPropagation()}
        title={t('Command palette (Ctrl+Shift+P)')}
      >
        <CommandIcon size={12} />
        {t('COMMANDS')}
        <span className="text-dim">Ctrl+Shift+P</span>
      </button>

      <div className="no-drag flex h-full" onDoubleClick={e => e.stopPropagation()}>
        <WindowButton label={t('Minimize')} onClick={() => void api.invoke('window:minimize')}>
          <Minus size={14} />
        </WindowButton>
        <WindowButton
          label={maximized ? t('Restore') : t('Maximize')}
          onClick={() => void api.invoke('window:toggle-maximize').then(st => setMaximized(st.maximized))}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </WindowButton>
        <WindowButton label={t('Close')} danger onClick={close}>
          <X size={15} />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton(props: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`flex h-full w-11 items-center justify-center text-muted transition-colors ${
        props.danger ? 'hover:bg-critical hover:text-void' : 'hover:bg-surface-2 hover:text-text'
      }`}
    >
      {props.children}
    </button>
  )
}
