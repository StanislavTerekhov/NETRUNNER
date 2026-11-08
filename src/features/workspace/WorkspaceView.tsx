import { FolderOpen, History } from 'lucide-react'
import { Panel } from '@/components/hud/Panel'
import { useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

export function WorkspaceView() {
  const workspace = useStore(s => s.workspace)
  const recent = useStore(s => s.recentWorkspaces)
  const pickWorkspace = useStore(s => s.pickWorkspace)
  const openRecent = useStore(s => s.openRecent)
  const t = useT()

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 p-2">
      <Panel title={t('ACTIVE WORKSPACE')}>
        <div className="flex flex-col gap-4 p-5">
          {workspace ? (
            <>
              <div className="font-mono text-[22px] font-bold tracking-wider text-primary">{workspace.name}</div>
              <div className="font-mono text-[12px] break-all text-muted">{workspace.root}</div>
            </>
          ) : (
            <div className="text-muted">{t('No workspace open. File access is limited to the folder you choose.')}</div>
          )}
          <button
            onClick={() => void pickWorkspace()}
            className="hud-cut-sm flex w-fit items-center gap-2 bg-primary px-4 py-2 font-mono text-[11px] font-bold tracking-wider text-void hover:brightness-110"
          >
            <FolderOpen size={14} /> {t('OPEN FOLDER')}
          </button>
        </div>
      </Panel>
      <Panel title={t('RECENT')} accent="secondary">
        <ul className="flex flex-col p-2">
          {recent.length === 0 && <li className="p-3 text-muted">{t('Nothing yet.')}</li>}
          {recent.map(root => (
            <li key={root}>
              <button
                onClick={() => void openRecent(root)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
              >
                <History size={13} className="shrink-0 text-secondary" />
                <span className="truncate font-mono text-[12px]">{root}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
