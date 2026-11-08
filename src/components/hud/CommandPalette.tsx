import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { getCommands } from '@/app/commands'
import { useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

export function CommandPalette() {
  const t = useT()
  const open = useStore(s => s.paletteOpen)
  const setOpen = useStore(s => s.setPaletteOpen)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = useMemo(() => {
    if (!open) return []
    const q = query.trim().toLowerCase()
    return getCommands()
      .filter(c => c.enabled?.() ?? true)
      .filter(c => !q || q.split(/\s+/).every(part => c.title.toLowerCase().includes(part)))
  }, [open, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => setIndex(0), [query])

  const run = (i: number) => {
    const cmd = commands[i]
    if (!cmd) return
    setOpen(false)
    void cmd.run()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-center bg-void/60 pt-24"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
          onMouseDown={() => setOpen(false)}
        >
          <motion.div
            data-testid="command-palette"
            className="hud-panel h-fit w-[560px] border border-line-bright shadow-[0_0_40px_rgba(0,229,255,0.08)]"
            initial={{ y: -8 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.12 }}
            onMouseDown={e => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false)
                else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIndex(i => Math.min(i + 1, commands.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIndex(i => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') run(index)
              }}
              placeholder={t('> type a command')}
              className="w-full border-b border-line bg-transparent px-4 py-3 font-mono text-[13px] text-text outline-none placeholder:text-dim"
            />
            <ul className="max-h-80 overflow-y-auto py-1">
              {commands.length === 0 && <li className="px-4 py-2 font-mono text-[12px] text-dim">{t('no matching commands')}</li>}
              {commands.map((c, i) => (
                <li key={c.id}>
                  <button
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(i)}
                    className={`flex w-full items-center px-4 py-1.5 text-left text-[12.5px] ${
                      i === index ? 'bg-secondary/10 text-secondary' : 'text-text'
                    }`}
                  >
                    {c.title}
                    {c.shortcut && <span className="ml-auto font-mono text-[11px] text-dim">{c.shortcut}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
