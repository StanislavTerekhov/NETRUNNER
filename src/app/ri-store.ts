import { create } from 'zustand'
import type { RiState } from '../../electron/shared/ipc'
import { api } from '@/lib/api'

/** Latest state of the reverse-interference monitor (main process samples it while a model is loaded). */
export const useRi = create<{ state: RiState | null }>(() => ({ state: null }))

api.on('ri:state', s => useRi.setState({ state: s }))
void api.invoke('ri:get').then(s => useRi.setState(st => ({ state: st.state ?? s })), () => undefined)
