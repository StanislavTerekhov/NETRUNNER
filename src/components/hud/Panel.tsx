import type { ReactNode } from 'react'

/** Angular HUD panel with a labelled header strip. */
export function Panel(props: {
  title: string
  accent?: 'primary' | 'secondary'
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Size to content instead of filling the parent's height. */
  fit?: boolean
}) {
  const accent = props.accent === 'secondary' ? 'bg-secondary' : 'bg-primary'
  return (
    <section className={`hud-panel flex min-h-0 flex-col ${props.fit ? 'shrink-0' : 'h-full'} ${props.className ?? ''}`}>
      <div className="hud-scanlines flex h-7 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className={`h-2 w-2 ${accent}`} />
        <h2 className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-muted">{props.title}</h2>
        <div className="ml-auto flex items-center gap-1">{props.actions}</div>
      </div>
      <div className={props.fit ? '' : 'min-h-0 flex-1'}>{props.children}</div>
    </section>
  )
}

export function IconButton(props: { title: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex h-5 w-5 items-center justify-center text-muted hover:text-secondary disabled:opacity-30 disabled:hover:text-muted"
    >
      {props.children}
    </button>
  )
}
