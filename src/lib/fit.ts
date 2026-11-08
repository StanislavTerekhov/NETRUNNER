export type FitKind = 'gpu' | 'hybrid' | 'too-large'

export interface FitEstimate {
  kind: FitKind
  /** Share of weights that fit into VRAM, 0..1. */
  gpuShare: number
  label: string
}

/** Headroom for KV cache, CUDA context and activations on top of the weights. */
const VRAM_OVERHEAD = 1.2
/** Leave room for the OS and other apps when spilling into system RAM. */
const RAM_USABLE = 0.75

/**
 * Rough placement estimate from the model file size and measured memory. It is a recommendation,
 * not a measurement; the Model Vault shows the measured VRAM once a model is loaded.
 */
export function estimateFit(modelBytes: number, vramBytes: number, ramBytes: number): FitEstimate {
  const need = modelBytes * VRAM_OVERHEAD
  if (vramBytes > 0 && need <= vramBytes) return { kind: 'gpu', gpuShare: 1, label: 'Fits fully in VRAM' }
  if (need <= vramBytes + ramBytes * RAM_USABLE) {
    const share = vramBytes > 0 ? Math.min(1, vramBytes / need) : 0
    return { kind: 'hybrid', gpuShare: share, label: `GPU+CPU offload (~${Math.round(share * 100)}% on GPU)` }
  }
  return { kind: 'too-large', gpuShare: 0, label: 'Too large for this machine' }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`
}
