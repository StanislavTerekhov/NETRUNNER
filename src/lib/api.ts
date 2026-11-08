import type { NetrunnerApi } from '../../electron/shared/ipc'

declare global {
  interface Window {
    netrunner: NetrunnerApi
  }
}

export const api: NetrunnerApi = window.netrunner

/** Electron prefixes IPC errors with "Error invoking remote method '<channel>': Error: ". */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}
