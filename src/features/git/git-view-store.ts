import { create } from 'zustand'
import type { ChangedFile, Checkpoint, FileVersions, GitStatus } from '../../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useStore } from '@/app/store'

interface GitViewState {
  status: GitStatus | null
  checkpoints: Checkpoint[]
  selected: string | null
  changes: ChangedFile[]
  file: FileVersions | null
  loading: boolean

  refresh(): Promise<void>
  init(): Promise<void>
  openCheckpoint(commit: string): void
  select(commit: string): Promise<void>
  openFile(path: string): Promise<void>
  restore(): Promise<void>
}

const notifyError = (err: unknown) => useStore.getState().notify('error', errorMessage(err))

export const useGitView = create<GitViewState>((set, get) => ({
  status: null,
  checkpoints: [],
  selected: null,
  changes: [],
  file: null,
  loading: false,

  async refresh() {
    try {
      const [status, checkpoints] = await Promise.all([api.invoke('git:status'), api.invoke('git:checkpoints')])
      set({ status, checkpoints })
      const sel = get().selected ?? checkpoints[0]?.commit ?? null
      if (sel) await get().select(sel)
    } catch (err) {
      notifyError(err)
    }
  },

  async init() {
    try {
      set({ status: await api.invoke('git:init') })
    } catch (err) {
      notifyError(err)
    }
  },

  openCheckpoint(commit) {
    set({ selected: commit, file: null })
  },

  async select(commit) {
    set({ selected: commit, loading: true })
    try {
      const changes = await api.invoke('git:changes', commit)
      set({ changes })
      const current = get().file?.path
      const next = changes.find(c => c.path === current) ?? changes[0]
      if (next) await get().openFile(next.path)
      else set({ file: null })
    } catch (err) {
      notifyError(err)
    } finally {
      set({ loading: false })
    }
  },

  async openFile(path) {
    const commit = get().selected
    if (!commit) return
    try {
      set({ file: await api.invoke('git:file-versions', commit, path) })
    } catch (err) {
      notifyError(err)
    }
  },

  async restore() {
    const commit = get().selected
    if (!commit) return
    try {
      await api.invoke('git:restore', commit)
      useStore.getState().notify('success', 'Workspace reverted to checkpoint')
      await useStore.getState().refreshTree()
      await get().select(commit)
    } catch (err) {
      if (!errorMessage(err).includes('cancelled')) notifyError(err)
    }
  },
}))
