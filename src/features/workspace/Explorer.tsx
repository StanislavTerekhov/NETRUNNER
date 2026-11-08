import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react'
import { Panel, IconButton } from '@/components/hud/Panel'
import { isDirty, useStore } from '@/app/store'
import { useT } from '@/lib/i18n'

/** An inline name field: a new file/folder inside `parent`, or renaming `path`. */
type Edit = { mode: 'file' | 'dir'; parent: string } | { mode: 'rename'; path: string; name: string }
type Menu = { x: number; y: number; path: string; kind: 'file' | 'dir' }

export function Explorer() {
  const workspace = useStore(s => s.workspace)
  const refreshTree = useStore(s => s.refreshTree)
  const pickWorkspace = useStore(s => s.pickWorkspace)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const t = useT()

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const ctx = { edit, setEdit, openMenu: setMenu }
  return (
    <Panel
      title={t('EXPLORER')}
      actions={
        <>
          <IconButton title={t('New file')} disabled={!workspace} onClick={() => setEdit({ mode: 'file', parent: '' })}>
            <FilePlus size={13} />
          </IconButton>
          <IconButton title={t('New folder')} disabled={!workspace} onClick={() => setEdit({ mode: 'dir', parent: '' })}>
            <FolderPlus size={13} />
          </IconButton>
          <IconButton title={t('Open folder')} onClick={() => void pickWorkspace()}>
            <FolderOpen size={13} />
          </IconButton>
          <IconButton title={t('Refresh')} disabled={!workspace} onClick={() => void refreshTree()}>
            <RefreshCw size={12} />
          </IconButton>
        </>
      }
    >
      {workspace ? (
        <div className="h-full overflow-auto py-1" role="tree" aria-label={workspace.name} onContextMenu={e => e.preventDefault()}>
          <div className="truncate px-3 pb-1 font-mono text-[11px] font-semibold tracking-wider text-secondary" title={workspace.root}>
            {workspace.name.toUpperCase()}
          </div>
          <DirChildren relPath="" depth={0} ctx={ctx} />
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-muted">
          <p className="text-[12px]">{t('No workspace open.')}</p>
          <button
            onClick={() => void pickWorkspace()}
            className="hud-cut-sm bg-primary px-4 py-1.5 font-mono text-[11px] font-bold tracking-wider text-void hover:brightness-110"
          >
            {t('OPEN FOLDER')}
          </button>
        </div>
      )}
      {menu && <ContextMenu menu={menu} setEdit={setEdit} close={() => setMenu(null)} />}
    </Panel>
  )
}

interface Ctx {
  edit: Edit | null
  setEdit: (e: Edit | null) => void
  openMenu: (m: Menu) => void
}

function ContextMenu({ menu, setEdit, close }: { menu: Menu; setEdit: (e: Edit | null) => void; close: () => void }) {
  const deleteEntry = useStore(s => s.deleteEntry)
  const t = useT()
  const toggleDir = useStore(s => s.toggleDir)
  const expanded = useStore(s => !!s.expanded[menu.path])
  const parent = menu.kind === 'dir' ? menu.path : menu.path.includes('/') ? menu.path.slice(0, menu.path.lastIndexOf('/')) : ''
  const item = (label: string, run: () => void, danger = false) => (
    <button
      data-menu={label}
      onMouseDown={e => e.stopPropagation()}
      onClick={() => {
        close()
        run()
      }}
      className={`w-full px-3 py-1 text-left hover:bg-surface-2 ${danger ? 'text-critical' : 'text-text'}`}
    >
      {t(label)}
    </button>
  )
  const startNew = (mode: 'file' | 'dir') => {
    if (menu.kind === 'dir' && !expanded) void toggleDir(menu.path)
    setEdit({ mode, parent })
  }
  return (
    <div data-testid="explorer-menu" className="fixed z-50 flex w-44 flex-col border border-line bg-surface py-1 font-mono text-[11px] shadow-[0_8px_24px_rgba(0,0,0,0.6)]" style={{ left: menu.x, top: menu.y }}>
      {item('NEW FILE', () => startNew('file'))}
      {item('NEW FOLDER', () => startNew('dir'))}
      {item('RENAME', () => setEdit({ mode: 'rename', path: menu.path, name: menu.path.split('/').pop()! }))}
      {item('DELETE', () => void deleteEntry(menu.path), true)}
    </div>
  )
}

/** Name input: Enter applies, Escape or leaving the field cancels. */
function NameInput({ initial, depth, onDone }: { initial: string; depth: number; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    const dot = initial.lastIndexOf('.')
    ref.current?.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  const finish = (name: string | null) => {
    if (finished.current) return
    finished.current = true
    onDone(name)
  }
  return (
    <div style={{ paddingLeft: 20 + depth * 12 }} className="pr-2">
      <input
        ref={ref}
        data-testid="explorer-name"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) finish(value.trim())
          if (e.key === 'Escape') finish(null)
        }}
        onBlur={() => finish(null)}
        className="w-full border border-secondary bg-void px-1 py-[1px] font-mono text-[12px] text-text outline-none"
      />
    </div>
  )
}

function DirChildren({ relPath, depth, ctx }: { relPath: string; depth: number; ctx: Ctx }) {
  const entries = useStore(s => s.dirs[relPath])
  const t = useT()
  const createEntry = useStore(s => s.createEntry)
  const creating = ctx.edit && ctx.edit.mode !== 'rename' && ctx.edit.parent === relPath ? ctx.edit : null
  const input = creating && (
    <NameInput
      initial=""
      depth={depth}
      onDone={name => {
        ctx.setEdit(null)
        if (name) void createEntry(relPath, name, creating.mode as 'file' | 'dir')
      }}
    />
  )
  if (!entries) return <div className="py-0.5 font-mono text-[11px] text-dim" style={{ paddingLeft: 12 + depth * 12 }}>{t('loading…')}</div>
  if (entries.length === 0)
    return (
      input ?? (
        <div className="py-0.5 font-mono text-[11px] text-dim" style={{ paddingLeft: 12 + depth * 12 }}>
          {t('empty')}
        </div>
      )
    )
  return (
    <>
      {input}
      {entries.map(e =>
        e.kind === 'dir' ? <DirNode key={e.path} path={e.path} name={e.name} depth={depth} ctx={ctx} /> : <FileNode key={e.path} path={e.path} name={e.name} depth={depth} ctx={ctx} />,
      )}
    </>
  )
}

function RenameInput({ path, depth, ctx }: { path: string; depth: number; ctx: Ctx }) {
  const renameEntry = useStore(s => s.renameEntry)
  const name = path.split('/').pop()!
  return (
    <NameInput
      initial={name}
      depth={depth}
      onDone={next => {
        ctx.setEdit(null)
        if (next && next !== name) void renameEntry(path, next)
      }}
    />
  )
}

function DirNode({ path, name, depth, ctx }: { path: string; name: string; depth: number; ctx: Ctx }) {
  const expanded = useStore(s => !!s.expanded[path])
  const toggleDir = useStore(s => s.toggleDir)
  if (ctx.edit?.mode === 'rename' && ctx.edit.path === path) return <RenameInput path={path} depth={depth} ctx={ctx} />
  return (
    <div role="treeitem" aria-expanded={expanded}>
      <button
        data-path={path}
        onClick={() => void toggleDir(path)}
        onContextMenu={e => ctx.openMenu({ x: e.clientX, y: e.clientY, path, kind: 'dir' })}
        className="flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12.5px] text-text hover:bg-surface-2"
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        {expanded ? <ChevronDown size={13} className="shrink-0 text-dim" /> : <ChevronRight size={13} className="shrink-0 text-dim" />}
        <Folder size={13} className="shrink-0 text-secondary/70" />
        <span className="truncate">{name}</span>
      </button>
      {expanded && <DirChildren relPath={path} depth={depth + 1} ctx={ctx} />}
    </div>
  )
}

function FileNode({ path, name, depth, ctx }: { path: string; name: string; depth: number; ctx: Ctx }) {
  const active = useStore(s => s.activePath === path)
  const dirty = useStore(s => s.tabs.some(t => t.path === path && isDirty(t)))
  const openFile = useStore(s => s.openFile)
  if (ctx.edit?.mode === 'rename' && ctx.edit.path === path) return <RenameInput path={path} depth={depth} ctx={ctx} />
  return (
    <button
      role="treeitem"
      data-path={path}
      onClick={() => void openFile(path)}
      onContextMenu={e => ctx.openMenu({ x: e.clientX, y: e.clientY, path, kind: 'file' })}
      className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12.5px] ${
        active ? 'bg-secondary/10 text-secondary' : 'text-text hover:bg-surface-2'
      }`}
      style={{ paddingLeft: 20 + depth * 12 }}
    >
      <FileText size={13} className="shrink-0 text-dim" />
      <span className="truncate">{name}</span>
      {dirty && <span className="ml-auto h-1.5 w-1.5 shrink-0 bg-primary" />}
    </button>
  )
}
