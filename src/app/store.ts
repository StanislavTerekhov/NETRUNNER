import { create } from 'zustand'
import type { DirEntry, WorkspaceInfo } from '../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { languageForPath } from '@/lib/languages'
import { t } from '@/lib/i18n'

export type SectionId =
  | 'workspace'
  | 'editor'
  | 'agents'
  | 'neural'
  | 'models'
  | 'terminal'
  | 'memory'
  | 'git'
  | 'system'
  | 'network'
  | 'forge'

export interface EditorTab {
  path: string
  language: string
  /** Content as last loaded from or written to disk. */
  savedContent: string
  /** Current buffer content. */
  content: string
  mtimeMs: number
  /** Set when the file changed or vanished on disk while the tab has unsaved edits (or was deleted). */
  disk?: 'changed' | 'deleted'
}

export interface Notice {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

interface State {
  section: SectionId
  workspace: WorkspaceInfo | null
  recentWorkspaces: string[]
  /** Directory listings keyed by relative path ('' is the root). */
  dirs: Record<string, DirEntry[]>
  expanded: Record<string, boolean>
  tabs: EditorTab[]
  activePath: string | null
  paletteOpen: boolean
  notices: Notice[]

  setSection(section: SectionId): void
  setPaletteOpen(open: boolean): void
  notify(kind: Notice['kind'], text: string): void
  dismissNotice(id: number): void
  init(): Promise<void>
  pickWorkspace(): Promise<void>
  openRecent(root: string): Promise<void>
  loadDir(relPath: string): Promise<void>
  toggleDir(relPath: string): Promise<void>
  refreshTree(): Promise<void>
  /** Line the editor should scroll to once the file is shown (from search results). */
  reveal: { path: string; line: number } | null
  openFile(relPath: string, line?: number): Promise<void>
  updateContent(relPath: string, content: string): void
  saveFile(relPath?: string): Promise<void>
  closeTab(relPath?: string): void
  setActive(relPath: string): void
  /** Paths changed on disk (agents, git, other tools): refresh listings and clean tabs. */
  diskChanged(paths: string[]): Promise<void>
  loadDirQuiet(relPath: string): Promise<void>
  /** Discard the tab's edits and load the file from disk again. */
  reloadTab(relPath: string): Promise<void>
  createEntry(parentRel: string, name: string, kind: 'file' | 'dir'): Promise<void>
  renameEntry(relPath: string, newName: string): Promise<void>
  deleteEntry(relPath: string): Promise<void>
}

let noticeSeq = 0

export const useStore = create<State>((set, get) => {
  api.on('fs:changed', paths => void get().diskChanged(paths))

  const setWorkspace = async (info: WorkspaceInfo) => {
    const settings = await api.invoke('settings:get')
    set({
      workspace: info,
      recentWorkspaces: settings.recentWorkspaces,
      dirs: {},
      expanded: { '': true },
      tabs: [],
      activePath: null,
      section: 'editor',
    })
    await get().loadDir('')
  }

  return {
    section: 'workspace',
    workspace: null,
    recentWorkspaces: [],
    dirs: {},
    expanded: { '': true },
    tabs: [],
    activePath: null,
    paletteOpen: false,
    notices: [],
    reveal: null,

    setSection: section => set({ section }),
    setPaletteOpen: paletteOpen => set({ paletteOpen }),

    notify(kind, text) {
      const id = ++noticeSeq
      set(s => ({ notices: [...s.notices.slice(-3), { id, kind, text }] }))
      setTimeout(() => get().dismissNotice(id), kind === 'error' ? 8000 : 3500)
    },
    dismissNotice: id => set(s => ({ notices: s.notices.filter(n => n.id !== id) })),

    async init() {
      const [settings, current] = await Promise.all([api.invoke('settings:get'), api.invoke('workspace:current')])
      set({ recentWorkspaces: settings.recentWorkspaces })
      if (current) await setWorkspace(current)
    },

    async pickWorkspace() {
      try {
        const info = await api.invoke('workspace:pick')
        if (info) await setWorkspace(info)
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    async openRecent(root) {
      try {
        await setWorkspace(await api.invoke('workspace:open', root))
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    async loadDir(relPath) {
      try {
        const entries = await api.invoke('fs:list', relPath)
        set(s => ({ dirs: { ...s.dirs, [relPath]: entries } }))
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    async toggleDir(relPath) {
      const open = !get().expanded[relPath]
      set(s => ({ expanded: { ...s.expanded, [relPath]: open } }))
      if (open && !get().dirs[relPath]) await get().loadDir(relPath)
    },

    async refreshTree() {
      const { expanded } = get()
      const open = Object.keys(expanded).filter(p => expanded[p])
      set({ dirs: {} })
      await Promise.all(open.map(p => get().loadDir(p)))
    },

    async openFile(relPath, line) {
      set({ reveal: line ? { path: relPath, line } : null })
      if (get().tabs.some(t => t.path === relPath)) {
        set({ activePath: relPath, section: 'editor' })
        return
      }
      try {
        const file = await api.invoke('fs:read', relPath)
        const tab: EditorTab = {
          path: file.path,
          language: languageForPath(file.path),
          savedContent: file.content,
          content: file.content,
          mtimeMs: file.mtimeMs,
        }
        set(s => ({ tabs: [...s.tabs, tab], activePath: file.path, section: 'editor' }))
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    updateContent(relPath, content) {
      set(s => ({ tabs: s.tabs.map(t => (t.path === relPath ? { ...t, content } : t)) }))
    },

    async saveFile(relPath) {
      const path = relPath ?? get().activePath
      const tab = get().tabs.find(t => t.path === path)
      if (!tab) return
      try {
        const written = await api.invoke('fs:write', tab.path, tab.content, tab.mtimeMs)
        set(s => ({
          tabs: s.tabs.map(t =>
            t.path === tab.path ? { ...t, savedContent: written.content, mtimeMs: written.mtimeMs, disk: undefined } : t,
          ),
        }))
        get().notify('success', t('Saved {path}', { path: tab.path }))
        void api.invoke('lsp:saved', tab.path).catch(() => undefined)
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    closeTab(relPath) {
      const path = relPath ?? get().activePath
      const { tabs, activePath } = get()
      const idx = tabs.findIndex(t => t.path === path)
      if (idx < 0) return
      const tab = tabs[idx]
      if (tab.content !== tab.savedContent && !window.confirm(t('{path} has unsaved changes. Close anyway?', { path: tab.path }))) return
      const next = tabs.filter(t => t.path !== path)
      set({
        tabs: next,
        activePath: activePath === path ? (next[Math.min(idx, next.length - 1)]?.path ?? null) : activePath,
      })
    },

    setActive: activePath => set({ activePath }),

    async diskChanged(paths) {
      const { dirs, tabs } = get()
      const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
      const reload = new Set<string>()
      for (const p of paths) {
        if (dirs[parentOf(p)]) reload.add(parentOf(p))
        if (dirs[p]) reload.add(p)
      }
      await Promise.all([...reload].map(d => get().loadDirQuiet(d)))
      const changed = new Set(paths)
      for (const tab of tabs.filter(t => changed.has(t.path))) {
        const file = await api.invoke('fs:read', tab.path).catch(() => null)
        const current = get().tabs.find(t => t.path === tab.path)
        if (!current) continue
        if (!file) {
          if (current.disk !== 'deleted') get().notify('error', t('{path} was deleted on disk', { path: tab.path }))
          set(s => ({ tabs: s.tabs.map(t => (t.path === tab.path ? { ...t, disk: 'deleted' } : t)) }))
          continue
        }
        if (file.content === current.savedContent) {
          set(s => ({ tabs: s.tabs.map(t => (t.path === tab.path ? { ...t, mtimeMs: file.mtimeMs, disk: undefined } : t)) }))
        } else if (!isDirty(current)) {
          // Clean tab: show what is on disk now (EditorArea pushes the new text into the Monaco model).
          set(s => ({ tabs: s.tabs.map(t => (t.path === tab.path ? { ...t, content: file.content, savedContent: file.content, mtimeMs: file.mtimeMs, disk: undefined } : t)) }))
        } else if (current.disk !== 'changed') {
          get().notify('error', t('{path} changed on disk while you have unsaved edits — RELOAD discards yours', { path: tab.path }))
          set(s => ({ tabs: s.tabs.map(t => (t.path === tab.path ? { ...t, disk: 'changed' } : t)) }))
        }
      }
    },

    async loadDirQuiet(relPath) {
      const entries = await api.invoke('fs:list', relPath).catch(() => null)
      set(s => {
        if (entries) return { dirs: { ...s.dirs, [relPath]: entries } }
        // The folder itself is gone: forget it and its open state.
        const dirsLeft = { ...s.dirs }
        delete dirsLeft[relPath]
        return { dirs: dirsLeft, expanded: { ...s.expanded, [relPath]: false } }
      })
    },

    async reloadTab(relPath) {
      const file = await api.invoke('fs:read', relPath).catch(err => (get().notify('error', errorMessage(err)), null))
      if (!file) return
      set(s => ({ tabs: s.tabs.map(t => (t.path === relPath ? { ...t, content: file.content, savedContent: file.content, mtimeMs: file.mtimeMs, disk: undefined } : t)) }))
    },

    async createEntry(parentRel, name, kind) {
      const rel = parentRel ? `${parentRel}/${name}` : name
      try {
        const entry = await api.invoke('fs:create', rel, kind)
        set(s => ({ expanded: { ...s.expanded, [parentRel]: true } }))
        await get().loadDirQuiet(parentRel)
        if (kind === 'file') await get().openFile(entry.path)
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    async renameEntry(relPath, newName) {
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      try {
        const to = await api.invoke('fs:rename', relPath, parent ? `${parent}/${newName}` : newName)
        // Open tabs follow the file (or everything under a renamed folder).
        const moved = (p: string) => (p === relPath ? to : p.startsWith(`${relPath}/`) ? to + p.slice(relPath.length) : p)
        set(s => ({
          tabs: s.tabs.map(t => ({ ...t, path: moved(t.path) })),
          activePath: s.activePath ? moved(s.activePath) : null,
        }))
        await get().loadDirQuiet(parent)
      } catch (err) {
        get().notify('error', errorMessage(err))
      }
    },

    async deleteEntry(relPath) {
      try {
        await api.invoke('fs:delete', relPath)
        const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
        await get().loadDirQuiet(parent)
        get().notify('success', t('{path} moved to the Recycle Bin', { path: relPath }))
      } catch (err) {
        if (!/cancelled/.test(errorMessage(err))) get().notify('error', errorMessage(err))
      }
    },
  }
})

export const isDirty = (t: EditorTab) => t.content !== t.savedContent
