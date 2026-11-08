import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Plus, RotateCcw, X } from 'lucide-react'
import type { PtyInfo } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { api, errorMessage } from '@/lib/api'
import { useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

const THEME = {
  background: '#0b0e11',
  foreground: '#d7dde2',
  cursor: '#fcee09',
  cursorAccent: '#07090b',
  selectionBackground: '#00e5ff40',
  black: '#101417',
  red: '#ff2442',
  green: '#19f5a5',
  yellow: '#fcee09',
  blue: '#3d8bff',
  magenta: '#d36bff',
  cyan: '#00e5ff',
  white: '#d7dde2',
  brightBlack: '#4d5862',
  brightRed: '#ff5c74',
  brightGreen: '#5dffc4',
  brightYellow: '#fff56b',
  brightBlue: '#7ab0ff',
  brightMagenta: '#e3a1ff',
  brightCyan: '#6bf3ff',
  brightWhite: '#ffffff',
}

/**
 * Shells outlive the panel: when a layout docks the terminal elsewhere the component re-mounts, finds the
 * running shells here and replays their recent output from the main process.
 */
interface Shell extends PtyInfo {
  n: number
  exited: number | null
}
let shells: Shell[] = []
let activeId: string | null = null
let seq = 0

/** PowerShell tabs in the workspace via node-pty in the main process; this component only renders them. */
export function TerminalView({ visible, docked = false }: { visible: boolean; docked?: boolean }) {
  const [, rerender] = useState(0)
  const refresh = () => rerender(n => n + 1)
  const [error, setError] = useState<string | null>(null)
  const workspace = useStore(s => s.workspace)
  const creating = useRef(false)
  const t = useT()

  const add = async () => {
    if (creating.current) return
    creating.current = true
    setError(null)
    try {
      const p = await api.invoke('pty:create')
      shells = [...shells, { ...p, n: ++seq, exited: null }]
      activeId = p.id
      refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      creating.current = false
    }
  }

  const close = (id: string) => {
    const s = shells.find(x => x.id === id)
    if (s && s.exited === null) void api.invoke('pty:kill', id)
    const idx = shells.findIndex(x => x.id === id)
    shells = shells.filter(x => x.id !== id)
    if (activeId === id) activeId = shells[Math.min(idx, shells.length - 1)]?.id ?? null
    refresh()
  }

  useEffect(
    () =>
      api.on('pty:exit', ({ id, code }) => {
        const s = shells.find(x => x.id === id)
        if (!s) return
        shells = shells.map(x => (x.id === id ? { ...x, exited: code } : x))
        refresh()
      }),
    [],
  )

  // Start the first shell lazily, the first time the panel is shown with a workspace open.
  useEffect(() => {
    if (visible && workspace && shells.length === 0 && !error) void add()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, workspace])

  const active = shells.find(s => s.id === activeId) ?? null
  return (
    <div className={docked ? 'h-full' : 'h-full p-2'}>
      <Panel
        title={`${t('TERMINAL')}${active ? ` // ${active.shell.split(/[\\/]/).pop()}` : ''}`}
        accent="secondary"
        actions={
          <>
            <IconButton title={t('New terminal tab')} disabled={!workspace} onClick={() => void add()}>
              <Plus size={13} />
            </IconButton>
            <IconButton
              title={t('Restart this shell')}
              disabled={!active}
              onClick={() => {
                if (!active) return
                close(active.id)
                void add()
              }}
            >
              <RotateCcw size={12} />
            </IconButton>
          </>
        }
      >
        <div className="flex h-full flex-col">
          {shells.length > 0 && (
            <div data-testid="terminal-tabs" className="flex h-7 shrink-0 items-end overflow-x-auto border-b border-line bg-void/40">
              {shells.map(s => (
                <div
                  key={s.id}
                  data-terminal-tab={s.n}
                  data-active={s.id === activeId}
                  onClick={() => {
                    activeId = s.id
                    refresh()
                  }}
                  className={`group flex h-full cursor-pointer items-center gap-2 border-r border-line px-3 font-mono text-[11px] ${
                    s.id === activeId ? 'border-t-2 border-t-secondary bg-surface text-text' : 'border-t-2 border-t-transparent text-muted hover:text-text'
                  }`}
                >
                  <span>
                    {s.n}: {s.shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, '')}
                    {s.exited !== null && <span className="text-critical"> ({t('exited')})</span>}
                  </span>
                  <button
                    aria-label={`${t('Close terminal')} ${s.n}`}
                    onClick={e => {
                      e.stopPropagation()
                      close(s.id)
                    }}
                    className="opacity-0 group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!workspace && <p className="p-3 text-[12px] text-muted">{t('Open a workspace to start a shell in it.')}</p>}
          {error && <p className="p-3 font-mono text-[12px] text-critical">{error}</p>}
          {active && (
            <div className="border-b border-line px-3 py-1 font-mono text-[10.5px] text-dim">
              cwd {active.cwd} · {t('network goes through the NETRUNNER policy proxy')}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {shells.map(s => (
              <ShellPane key={s.id} shell={s} active={s.id === activeId} visible={visible} />
            ))}
          </div>
        </div>
      </Panel>
    </div>
  )
}

/** One xterm bound to one shell; kept mounted while its tab exists so scrollback and state survive tab switches. */
function ShellPane({ shell, active, visible }: { shell: Shell; active: boolean; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const t = new Terminal({
      theme: THEME,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    fit.current = f
    const id = shell.id
    t.onData(d => void api.invoke('pty:write', id, d))
    t.onResize(({ cols, rows }) => void api.invoke('pty:resize', id, cols, rows))
    // Output that arrives before the replay is already part of the replayed buffer (main → renderer messages
    // keep their order), so it is dropped until the replay lands.
    let replaying = true
    const offData = api.on('pty:data', ({ id: from, data }) => from === id && !replaying && t.write(data))
    const offExit = api.on('pty:exit', ({ id: from, code }) => from === id && t.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`))
    void api.invoke('pty:buffer', id).then(
      buf => {
        replaying = false
        if (buf) t.write(buf)
        if (host.current?.offsetParent) f.fit()
        void api.invoke('pty:resize', id, t.cols, t.rows)
      },
      () => (replaying = false),
    )
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) f.fit()
    })
    ro.observe(host.current!)
    return () => {
      // The shell keeps running (main kills all shells on quit, or the tab's close button); only the view goes.
      ro.disconnect()
      offData()
      offExit()
      t.dispose()
    }
  }, [shell.id])

  useEffect(() => {
    const show = active && visible
    if (show) requestAnimationFrame(() => fit.current?.fit())
    // Hidden terminals stay mounted; stop their blink timers while they cannot be seen.
    if (term.current) term.current.options.cursorBlink = show
    if (show) term.current?.focus()
  }, [active, visible])

  return (
    <div
      ref={host}
      data-testid={active ? 'terminal' : undefined}
      data-shell={shell.n}
      className={`absolute inset-0 bg-[#0b0e11] p-1 select-text ${active ? '' : 'invisible'}`}
    />
  )
}
