// Reverse interference (NSC stage 2): when something else on the PC slows NETRUNNER's models down. Shared by the main
// process and the UI.

export type RiKind = 'ram-pressure' | 'vram-others' | 'cpu-contention' | 'speed-drop'
export type RiResource = 'cpu' | 'ram' | 'vram' | 'gpu'

export interface RiFinding {
  kind: RiKind
  severity: 'info' | 'warn' | 'critical'
  /** The measured value and the threshold it crossed. */
  value: number
  limit: number
  unit: '%' | 'GiB' | 'tok/s'
  resource?: RiResource
  /** speed-drop: the model and its usual speed. */
  model?: string
  usual?: number
  /** First time this finding was seen (ms), kept while it lasts. */
  since: number
}

export interface RiState {
  time: number
  /** A model is loaded, so the monitor is sampling. */
  active: boolean
  findings: RiFinding[]
  /** Share of each resource NETRUNNER's own processes take (%), null when unknown. */
  own: Record<RiResource, number | null>
  /** Share of each resource in use by everything together (%). */
  total: Record<RiResource, number | null>
  /** Findings that have ended, newest first (kind, severity, when, how long). */
  history: { kind: RiKind; severity: RiFinding['severity']; resource?: RiResource; since: number; until: number }[]
}
