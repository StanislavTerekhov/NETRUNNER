import { motion } from 'motion/react'
import { isAvailable, SECTIONS } from '@/app/sections'
import { useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

export function NavRail() {
  const section = useStore(s => s.section)
  const setSection = useStore(s => s.setSection)
  const t = useT()

  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden border-r border-line bg-void py-1.5" aria-label={t('Sections')}>
      {SECTIONS.map(sec => {
        const active = sec.id === section
        const Icon = sec.icon
        return (
          <button
            key={sec.id}
            data-section={sec.id}
            title={!isAvailable(sec) ? `${t(sec.label)} — phase ${sec.phase}` : t(sec.label)}
            onClick={() => setSection(sec.id)}
            className={`relative flex w-full shrink-0 flex-col items-center justify-center gap-[3px] py-1.5 transition-colors ${
              active ? 'text-primary' : !isAvailable(sec) ? 'text-dim hover:text-muted' : 'text-muted hover:text-text'
            }`}
          >
            {active && (
              <motion.span
                layoutId="nav-active"
                className="absolute inset-y-1.5 left-0 w-[2px] bg-primary shadow-[0_0_8px_var(--color-primary)]"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
            <Icon size={18} strokeWidth={active ? 2.2 : 1.6} aria-hidden />
            <span data-nav-caption className="max-w-full truncate px-0.5 font-mono text-[9px] leading-none tracking-[0.04em]">
              {t(sec.short)}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
