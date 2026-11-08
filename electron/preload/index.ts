import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type NetrunnerApi } from '../shared/ipc'

// Only allowlisted channels are reachable; ipcRenderer itself is never exposed.
const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

const api: NetrunnerApi = {
  invoke(channel, ...args) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: EventChannel, listener) {
    if (!eventAllowed.has(channel)) throw new Error(`Channel not allowed: ${channel}`)
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  },
}

contextBridge.exposeInMainWorld('netrunner', api)
