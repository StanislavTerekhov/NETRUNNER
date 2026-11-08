import { create } from 'zustand'
import type {
  HardwareInfo,
  ModelDetails,
  ModelInfo,
  ModelRoles,
  ModelSourceInfo,
  NetworkMode,
  PullProgress,
  RunningModel,
  RuntimeStatus,
  Settings,
} from '../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useStore } from './store'

interface AiState {
  status: RuntimeStatus | null
  models: ModelInfo[]
  details: Record<string, ModelDetails>
  running: RunningModel[]
  hardware: HardwareInfo | null
  settings: Settings | null
  pulls: Record<string, PullProgress>
  busy: Record<string, string>
  roles: ModelRoles
  /** Model folders: NETRUNNER's own and LM Studio's (read in place). */
  sources: ModelSourceInfo[]

  refresh(): Promise<void>
  setLmStudioDir(mode: 'pick' | 'auto'): Promise<void>
  setRole(role: keyof ModelRoles, name: string | null): Promise<void>
  /** Human-readable name for a model id. */
  label(name: string | null | undefined): string
  /** Runtime status and loaded models; hardware (spawns nvidia-smi) only when asked for. */
  refreshRunning(withHardware?: boolean): Promise<void>
  loadDetails(name: string): Promise<ModelDetails | null>
  setNetworkMode(mode: NetworkMode): Promise<void>
  setDefaultModel(name: string | null): Promise<void>
  loadModel(name: string): Promise<void>
  unloadModel(name: string): Promise<void>
  deleteModel(name: string): Promise<void>
  pull(name: string): Promise<void>
  cancelPull(pullId: string): Promise<void>
}

const notifyError = (err: unknown) => useStore.getState().notify('error', errorMessage(err))

export const useAi = create<AiState>((set, get) => {
  api.on('models:pull-progress', p => {
    set(s => ({ pulls: { ...s.pulls, [p.pullId]: p } }))
    if (p.done) {
      if (p.error) useStore.getState().notify('error', `${p.model}: ${p.error}`)
      else useStore.getState().notify('success', `Downloaded ${p.model}`)
      void get().refresh()
    }
  })

  const withBusy = async (name: string, label: string, fn: () => Promise<void>) => {
    set(s => ({ busy: { ...s.busy, [name]: label } }))
    try {
      await fn()
    } catch (err) {
      notifyError(err)
    } finally {
      set(s => {
        const busy = { ...s.busy }
        delete busy[name]
        return { busy }
      })
    }
  }

  return {
    status: null,
    models: [],
    details: {},
    running: [],
    hardware: null,
    settings: null,
    pulls: {},
    busy: {},
    roles: { general: null, agent: null, embedding: null },
    sources: [],

    async refresh() {
      const [status, settings, hardware] = await Promise.all([
        api.invoke('runtime:status'),
        api.invoke('settings:get'),
        api.invoke('hardware:info').catch(() => null),
      ])
      set({ status, settings, hardware })
      try {
        // Models are files on disk: they are listed even when the runtime is not installed yet.
        const [models, running, roles, sources] = await Promise.all([
          api.invoke('models:list'),
          api.invoke('models:running'),
          api.invoke('models:roles'),
          api.invoke('models:sources'),
        ])
        set({ models, running, roles, sources })
        await Promise.all(models.map(m => get().loadDetails(m.name)))
      } catch (err) {
        notifyError(err)
      }
    },

    async setRole(role, name) {
      const channel = role === 'general' ? 'settings:set-default-model' : role === 'agent' ? 'settings:set-agent-model' : 'settings:set-embedding-model'
      try {
        set({ settings: await api.invoke(channel, name), roles: await api.invoke('models:roles') })
      } catch (err) {
        notifyError(err)
      }
    },

    async setLmStudioDir(mode) {
      try {
        set({ settings: await api.invoke('settings:set-lmstudio-dir', mode) })
        await get().refresh()
      } catch (err) {
        notifyError(err)
      }
    },

    label(name) {
      if (!name) return '—'
      return get().models.find(m => m.name === name)?.label ?? name.split('/').pop()!.replace(/\.gguf$/i, '')
    },

    async refreshRunning(withHardware = false) {
      const status = await api.invoke('runtime:status')
      set({ status })
      const [running, hardware] = await Promise.all([
        api.invoke('models:running').catch(() => get().running),
        withHardware ? api.invoke('hardware:info').catch(() => get().hardware) : Promise.resolve(get().hardware),
      ])
      set({ running, hardware })
    },

    async loadDetails(name) {
      if (get().details[name]) return get().details[name]
      try {
        const d = await api.invoke('models:details', name)
        set(s => ({ details: { ...s.details, [name]: d } }))
        return d
      } catch {
        return null
      }
    },

    async setNetworkMode(mode) {
      try {
        set({ settings: await api.invoke('settings:set-network-mode', mode) })
      } catch (err) {
        notifyError(err)
      }
    },

    async setDefaultModel(name) {
      set({ settings: await api.invoke('settings:set-default-model', name) })
    },

    loadModel: name =>
      withBusy(name, 'loading', async () => {
        await api.invoke('models:load', name)
        await get().refreshRunning()
      }),
    unloadModel: name =>
      withBusy(name, 'unloading', async () => {
        await api.invoke('models:unload', name)
        await get().refreshRunning()
      }),
    deleteModel: name =>
      withBusy(name, 'deleting', async () => {
        await api.invoke('models:delete', name)
        await get().refresh()
      }),

    async pull(name) {
      try {
        const pullId = await api.invoke('models:pull', name)
        set(s => ({
          pulls: {
            ...s.pulls,
            [pullId]: { pullId, model: name, status: 'starting', completedBytes: null, totalBytes: null, done: false, error: null },
          },
        }))
      } catch (err) {
        notifyError(err)
      }
    },

    async cancelPull(pullId) {
      await api.invoke('models:pull-cancel', pullId)
    },
  }
})
