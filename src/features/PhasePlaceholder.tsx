import { Panel } from '@/components/hud/Panel'
import type { SectionDef } from '@/app/sections'
import { useT } from '@/lib/i18n'

/**
 * Shown for sections whose backend does not exist yet. It states that the module is not implemented
 * instead of rendering fake data.
 */
export function PhasePlaceholder({ section }: { section: SectionDef }) {
  const Icon = section.icon
  const t = useT()
  return (
    <div className="h-full p-2">
      <Panel title={t(section.label)}>
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
          <Icon size={42} strokeWidth={1.2} className="text-line-bright" />
          <div className="font-mono text-[13px] tracking-[0.25em] text-muted">{t('MODULE OFFLINE')}</div>
          <div className="hud-cut-sm border border-primary/40 px-3 py-1 font-mono text-[11px] text-primary">
            {t('SCHEDULED FOR PHASE')} {section.phase}
          </div>
          <p className="max-w-md text-[12.5px] text-dim">{t(section.summary)}</p>
        </div>
      </Panel>
    </div>
  )
}
