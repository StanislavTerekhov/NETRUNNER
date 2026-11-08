import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AppInfo } from '../../../electron/shared/ipc'
import { api } from '@/lib/api'
import { isDirty, useStore } from '@/app/store'
import { useAi } from '@/app/ai-store'
import { useT } from '@/lib/i18n'
import { InterferenceBadge } from './Interference'

const MODE_LABEL = { 'strict-offline': 'STRICT OFFLINE', 'local-network': 'LOCAL NETWORK', 'online-tools': 'ONLINE TOOLS' } as const

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const tabs = useStore(s => s.tabs)
  const activePath = useStore(s => s.activePath)
  const notices = useStore(s => s.notices)
  const dismiss = useStore(s => s.dismissNotice)
  const status = useAi(s => s.status)
  const running = useAi(s => s.running)
  const mode = useAi(s => s.settings?.networkMode)
  const active = tabs.find(t => t.path === activePath)
  const dirtyCount = tabs.filter(isDirty).length
  const t = useT()

  useEffect(() => {
    void api.invoke('app:info').then(setInfo)
    void useAi.getState().refresh()
    // Light poll (two loopback HTTP calls, no helper processes), paused while the window is hidden.
    const t = setInterval(() => !document.hidden && void useAi.getState().refreshRunning(false), 10000)
    return () => clearInterval(t)
  }, [])

  return (
    <>
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-void px-3 font-mono text-[10.5px] text-muted">
        <span data-testid="runtime-status" className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 ${status?.reachable ? 'bg-success' : status ? 'bg-critical' : 'bg-dim'}`} />
          {status?.reachable ? `LLAMA.CPP ${status.version}` : status ? t('AI RUNTIME: NOT INSTALLED') : t('AI RUNTIME: …')}
          {running.length > 0 && <span className="text-secondary">· {running.map(r => useAi.getState().label(r.name)).join(', ')}</span>}
        </span>
        {mode && <span className={mode === 'online-tools' ? 'text-primary' : 'text-success'}>{t('NET')}: {t(MODE_LABEL[mode])}</span>}
        <InterferenceBadge />
        <span>{dirtyCount > 0 ? <span className="text-primary">{t('{n} UNSAVED', { n: dirtyCount })}</span> : t('ALL SAVED')}</span>
        <span className="ml-auto">{active ? active.language.toUpperCase() : ''}</span>
        {info && (
          <span className="text-dim">
            v{info.version} · electron {info.electron} · {info.platform}
          </span>
        )}
      </footer>

      <div className="pointer-events-none fixed right-4 bottom-9 z-40 flex w-96 flex-col gap-2">
        <AnimatePresence>
          {notices.map(n => (
            <motion.button
              key={n.id}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.15 }}
              onClick={() => dismiss(n.id)}
              className={`hud-cut-sm pointer-events-auto border-l-2 bg-surface-2 px-3 py-2 text-left font-mono text-[11.5px] ${
                n.kind === 'error' ? 'border-critical text-critical' : n.kind === 'success' ? 'border-success text-success' : 'border-secondary text-secondary'
              }`}
            >
              {n.text}
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </>
  )
}
