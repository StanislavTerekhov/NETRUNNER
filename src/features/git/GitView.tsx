import { useEffect } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { FolderGit2, RefreshCw, Undo2 } from 'lucide-react'
import '@/features/editor/monaco-setup'
import { Panel, IconButton } from '@/components/hud/Panel'
import { useStore } from '@/app/store'
import { languageForPath } from '@/lib/languages'
import { useGitView } from './git-view-store'
import { useT } from '@/lib/i18n'

const STATUS_COLOR = { A: 'text-success', M: 'text-primary', D: 'text-critical' } as const

export function GitView() {
  const workspace = useStore(s => s.workspace)
  const { status, checkpoints, selected, changes, file, loading } = useGitView()
  const { refresh, init, select, openFile, restore } = useGitView.getState()
  const t = useT()

  useEffect(() => {
    if (workspace) void refresh()
  }, [workspace, refresh])

  if (!workspace) {
    return (
      <div className="h-full p-2">
        <Panel title="GIT">
          <p className="p-4 text-muted">{t('Open a workspace first.')}</p>
        </Panel>
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="h-full p-2">
        <Panel title="GIT">
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <FolderGit2 size={40} strokeWidth={1.2} className="text-line-bright" />
            <p className="max-w-md text-[12.5px] text-muted">
              {t('{name} is not a git repository. Agent checkpoints and diff review need git; initializing creates a local repository only (no commits, no remote).', { name: workspace.name })}
            </p>
            <button onClick={() => void init()} className="hud-cut-sm bg-primary px-4 py-1.5 font-mono text-[11px] font-bold text-void">
              GIT INIT
            </button>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] gap-2 p-2">
      <div className="flex min-h-0 flex-col gap-2">
        <Panel
          title={t('REPOSITORY')}
          fit
          actions={
            <IconButton title={t('Refresh')} onClick={() => void refresh()}>
              <RefreshCw size={12} />
            </IconButton>
          }
        >
          <div className="flex flex-col gap-1 p-3 font-mono text-[11px]">
            <span className="text-text">
              {t('branch')} <span className="text-secondary">{status?.branch ?? t('(detached)')}</span>
            </span>
            <span className="text-muted">HEAD {status?.head?.slice(0, 10) ?? t('(no commits)')}</span>
            <span className="text-muted">{t('{n} uncommitted change(s)', { n: status?.files.length ?? 0 })}</span>
          </div>
        </Panel>
        <Panel title={t('CHECKPOINTS')} accent="secondary" className="flex-1">
          <ul data-testid="checkpoints" className="h-full overflow-auto py-1">
            {checkpoints.length === 0 && <li className="px-3 py-2 text-[12px] text-dim">{t('No checkpoints yet. One is taken before every agent task.')}</li>}
            {checkpoints.map(c => (
              <li key={c.commit}>
                <button
                  onClick={() => void select(c.commit)}
                  className={`flex w-full flex-col px-3 py-1.5 text-left ${selected === c.commit ? 'bg-secondary/10 text-secondary' : 'text-text hover:bg-surface-2'}`}
                >
                  <span className="truncate text-[12px]">{c.label}</span>
                  <span className="font-mono text-[10px] text-dim">
                    {new Date(c.time).toLocaleString()} · {c.commit.slice(0, 8)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        title={`${t('CHANGES SINCE CHECKPOINT')}${loading ? ' // …' : ` // ${t('{n} FILE(S)', { n: changes.length })}`}`}
        actions={
          selected && changes.length > 0 ? (
            <button
              data-testid="revert-checkpoint"
              onClick={() => void restore()}
              className="flex items-center gap-1 border border-critical px-2 font-mono text-[10px] text-critical hover:bg-critical/10"
            >
              <Undo2 size={11} /> {t('REVERT ALL')}
            </button>
          ) : null
        }
      >
        <div className="flex h-full min-h-0">
          <ul data-testid="changed-files" className="w-60 shrink-0 overflow-auto border-r border-line py-1">
            {selected && changes.length === 0 && !loading && <li className="px-3 py-2 text-[12px] text-dim">{t('No changes.')}</li>}
            {changes.map(c => (
              <li key={c.path}>
                <button
                  onClick={() => void openFile(c.path)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[11.5px] ${file?.path === c.path ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                >
                  <span className={STATUS_COLOR[c.status]}>{c.status}</span>
                  <span className="truncate text-text">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1">
            {file ? (
              <DiffEditor
                original={file.original}
                modified={file.modified}
                language={languageForPath(file.path)}
                theme="netrunner"
                options={{ readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5 }}
              />
            ) : (
              <p className="p-4 text-[12px] text-dim">{t('Select a checkpoint and a file to review the diff.')}</p>
            )}
          </div>
        </div>
      </Panel>
    </div>
  )
}
