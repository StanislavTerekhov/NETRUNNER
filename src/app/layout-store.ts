import { create } from 'zustand'
import type { WorkspaceLayout } from '../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useStore } from './store'

/** Built-in presets; saved layouts come from the settings file. */
export const BUILTIN_LAYOUTS: WorkspaceLayout[] = [
  { id: 'classic', name: 'CLASSIC', explorer: true, terminal: 'section', chat: false },
  { id: 'code', name: 'CODE', explorer: true, terminal: 'bottom', chat: false },
  { id: 'ai-pair', name: 'AI PAIR', explorer: true, terminal: 'bottom', chat: true },
  { id: 'side-terminal', name: 'SIDE TERMINAL', explorer: false, terminal: 'right', chat: false },
  { id: 'focus', name: 'FOCUS', explorer: false, terminal: 'section', chat: false },
]

const isBuiltin = (id: string) => BUILTIN_LAYOUTS.some(l => l.id === id)

interface LayoutState {
  saved: WorkspaceLayout[]
  activeId: string
  /** What the editor screen shows now: the active layout, possibly changed and not saved yet (built-ins). */
  current: WorkspaceLayout
  modified: boolean

  init(): Promise<void>
  all(): WorkspaceLayout[]
  apply(id: string): Promise<void>
  /** Change the current layout; a saved layout is updated in place, a built-in one becomes "modified". */
  change(partial: Partial<Omit<WorkspaceLayout, 'id' | 'name'>>): Promise<void>
  saveAs(name: string): Promise<void>
  remove(id: string): Promise<void>
}

export const useLayout = create<LayoutState>((set, get) => {
  const persist = async (saved: WorkspaceLayout[], activeId: string) => {
    try {
      await api.invoke('settings:set-layouts', saved, activeId)
    } catch (err) {
      useStore.getState().notify('error', errorMessage(err))
    }
  }

  return {
    saved: [],
    activeId: 'classic',
    current: BUILTIN_LAYOUTS[0],
    modified: false,

    async init() {
      const s = await api.invoke('settings:get')
      const all = [...BUILTIN_LAYOUTS, ...s.layouts]
      const current = all.find(l => l.id === s.activeLayout) ?? BUILTIN_LAYOUTS[0]
      set({ saved: s.layouts, activeId: current.id, current, modified: false })
    },

    all: () => [...BUILTIN_LAYOUTS, ...get().saved],

    async apply(id) {
      const layout = get().all().find(l => l.id === id)
      if (!layout) return
      set({ activeId: id, current: layout, modified: false })
      await persist(get().saved, id)
    },

    async change(partial) {
      const current = { ...get().current, ...partial }
      if (isBuiltin(current.id)) {
        set({ current, modified: true })
        return
      }
      const saved = get().saved.map(l => (l.id === current.id ? current : l))
      set({ current, saved, modified: false })
      await persist(saved, current.id)
    },

    async saveAs(name) {
      const clean = name.trim().slice(0, 40)
      if (!clean) return
      const existing = get().saved.find(l => l.name.toLowerCase() === clean.toLowerCase())
      const id = existing?.id ?? `u${Date.now().toString(36)}`
      const layout: WorkspaceLayout = { ...get().current, id, name: clean }
      const saved = existing ? get().saved.map(l => (l.id === id ? layout : l)) : [...get().saved, layout]
      set({ saved, activeId: id, current: layout, modified: false })
      await persist(saved, id)
    },

    async remove(id) {
      if (isBuiltin(id)) return
      const saved = get().saved.filter(l => l.id !== id)
      const active = get().activeId === id ? BUILTIN_LAYOUTS[0] : get().current
      set({ saved, activeId: active.id, current: active, modified: get().activeId === id ? false : get().modified })
      await persist(saved, active.id)
    },
  }
})
