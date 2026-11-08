import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LayoutPanelLeft, Save, X } from 'lucide-react'
import type { WorkspaceLayout } from '../../../electron/shared/ipc'
import { BUILTIN_LAYOUTS, useLayout } from '@/app/layout-store'
import { useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

const TERMINAL_DOCKS: { id: WorkspaceLayout['terminal']; label: string }[] = [
  { id: 'section', label: 'OWN SECTION' },
  { id: 'bottom', label: 'BELOW EDITOR' },
  { id: 'right', label: 'RIGHT SIDE' },
]

/** Title-bar menu: pick a layout, change what the editor screen shows, save it under a name. */
export function LayoutMenu() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { current, modified, saved, apply, change, saveAs, remove } = useLayout()
  const setSection = useStore(s => s.setSection)
  const t = useT()

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const pick = (id: string) => {
    void apply(id)
    setSection('editor')
    setOpen(false)
  }

  return (
    <div ref={ref} className="no-drag relative mr-2" onDoubleClick={e => e.stopPropagation()}>
      <button
        data-testid="layout-menu"
        onClick={() => setOpen(o => !o)}
        title={t('Workspace layout')}
        className="hud-cut-sm flex h-6 items-center gap-2 border border-line bg-surface px-3 font-mono text-[11px] text-muted hover:border-secondary hover:text-secondary"
      >
        <LayoutPanelLeft size={12} />
        <span data-testid="layout-current" className="text-text">
          {t(current.name)}
          {modified ? ' *' : ''}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute top-7 right-0 z-50 flex w-64 flex-col border border-line bg-surface font-mono text-[11px] shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
          <div className="border-b border-line px-3 py-1 text-[10px] tracking-wider text-dim">{t('LAYOUTS')}</div>
          {[...BUILTIN_LAYOUTS, ...saved].map(l => (
            <div key={l.id} className="group flex items-center">
              <button data-layout={l.id} onClick={() => pick(l.id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left hover:bg-surface-2">
                <span className="w-3">{current.id === l.id && <Check size={11} className="text-primary" />}</span>
                <span className={current.id === l.id ? 'text-primary' : 'text-text'}>{t(l.name)}</span>
                <span className="ml-auto truncate text-[10px] text-dim">{describe(l, t)}</span>
              </button>
              {!BUILTIN_LAYOUTS.some(b => b.id === l.id) && (
                <button title={t('Delete {name}', { name: l.name })} onClick={() => void remove(l.id)} className="hidden px-2 text-dim group-hover:block hover:text-critical">
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
          <div className="border-y border-line px-3 py-1 text-[10px] tracking-wider text-dim">{t('THIS LAYOUT')}</div>
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <Toggle id="explorer" label={t('EXPLORER')} on={current.explorer} onChange={v => void change({ explorer: v })} />
            <Toggle id="chat" label={t('CHAT BESIDE CODE')} on={current.chat} onChange={v => void change({ chat: v })} />
            <div className="flex items-center gap-1">
              <span className="w-20 text-muted">{t('TERMINAL')}</span>
              {TERMINAL_DOCKS.map(d => (
                <button
                  key={d.id}
                  data-terminal-dock={d.id}
                  onClick={() => void change({ terminal: d.id })}
                  className={`border px-1 py-0.5 text-[9.5px] ${current.terminal === d.id ? 'border-primary text-primary' : 'border-line text-muted hover:text-text'}`}
                >
                  {t(d.label)}
                </button>
              ))}
            </div>
          </div>
          <form
            className="flex gap-1 border-t border-line p-2"
            onSubmit={e => {
              e.preventDefault()
              if (!name.trim()) return
              void saveAs(name)
              setName('')
            }}
          >
            <input
              data-testid="layout-name"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={40}
              placeholder={t('save as…')}
              className="min-w-0 flex-1 border border-line bg-void px-2 py-0.5 text-text outline-none placeholder:text-dim focus:border-secondary"
            />
            <button data-testid="layout-save" disabled={!name.trim()} className="flex items-center gap-1 bg-primary px-2 font-bold text-void disabled:bg-line disabled:text-dim">
              <Save size={11} /> {t('SAVE')}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function describe(l: WorkspaceLayout, t: (s: string) => string): string {
  return [l.explorer ? t('files') : null, t('code'), l.terminal !== 'section' ? t(`term ${l.terminal}`) : null, l.chat ? t('chat') : null].filter(Boolean).join(' · ')
}

function Toggle({ id, label, on, onChange }: { id: string; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button data-layout-toggle={id} data-on={on} onClick={() => onChange(!on)} className="flex items-center gap-2 text-left">
      <span className={`flex h-3 w-3 items-center justify-center border ${on ? 'border-primary bg-primary/20' : 'border-line'}`}>{on && <Check size={9} className="text-primary" />}</span>
      <span className={on ? 'text-text' : 'text-muted'}>{label}</span>
    </button>
  )
}
