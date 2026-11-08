import { useEffect } from 'react'
import { create } from 'zustand'
import type { TelemetrySample } from '../../electron/shared/ipc'
import { api } from '@/lib/api'

const HISTORY = 150 // 5 minutes at one sample per 2 s

interface TelemetryState {
  samples: TelemetrySample[]
}

export const useTelemetry = create<TelemetryState>(() => ({ samples: [] }))

api.on('telemetry:sample', s => useTelemetry.setState(st => ({ samples: [...st.samples.slice(-(HISTORY - 1)), s] })))

/** Keeps the main-process sampler running while the calling view is mounted. */
export function useTelemetrySubscription(active = true): void {
  useEffect(() => {
    if (!active) return
    void api.invoke('telemetry:subscribe')
    return () => void api.invoke('telemetry:unsubscribe')
  }, [active])
}
