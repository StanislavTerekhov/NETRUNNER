// Autotuner (NSC stage 3): per-model llama-server launch settings found by measurement, with automatic rollback.

/** Launch settings that override NETRUNNER's defaults for one model (absent = the default). */
export interface LaunchProfile {
  /** CPU threads for generation and prompt processing (-t / -tb). */
  threads?: number
  /** Prompt batch size (-b / -ub). */
  ubatch?: number
  /** Speculative decoding with the model's own MTP head. */
  mtp?: boolean
  /**
   * MoE models: every expert stays in RAM and the GPU keeps a cache of this many MiB of them (llama.cpp
   * --cpu-moe --moe-cache-mib); all experts then run on the GPU, missing ones are copied over PCIe.
   */
  moeCacheMib?: number
  /**
   * MoE models, approximate mode: experts used per token instead of the model's own number (GGUF metadata override).
   * Faster, and quality may drop; the autotuner never sets it — only the user does.
   */
  expertsUsed?: number
  /**
   * MoE models, VRAM saver (NSC-ME phase 6): all experts in RAM (--cpu-moe), only the shared weights and the context on
   * the GPU. Qwen3-Coder-Next: 10.2 → 4.8 GB of VRAM at −9% generation; it then keeps its speed next to a program that
   * takes 3–6 GB of VRAM, where the default placement got 2× slower. Set by the operator only; replaces the expert cache.
   */
  cpuMoe?: boolean
}

export interface BenchResult {
  /** Generation speed, mean of the benchmark requests. */
  genTokPerS: number
  /** Prompt reading speed on the long request. */
  promptTokPerS: number
  loadMs: number
}

export interface ModelProfile {
  model: string
  /** Tuned for NEURAL CORE chat or for the agents (different benchmarks; older profiles have none: chat). */
  use?: 'chat' | 'agent'
  /** What is applied at launch ({} = NETRUNNER's defaults). */
  profile: LaunchProfile
  status: 'active' | 'reverted'
  tunedAt: string
  /** The defaults, measured at the start and again at the end of the run (the difference is the noise). */
  defaults: BenchResult
  defaultsAgain: BenchResult | null
  chosen: BenchResult
  tried: { profile: LaunchProfile; result: BenchResult | null; error?: string; kept: boolean }[]
  /** Why the profile was reverted. */
  note: string | null
}

export type AutotuneEvent =
  | { type: 'start'; model: string; candidates: number }
  | { type: 'measured'; model: string; profile: LaunchProfile; result: BenchResult | null; error?: string; kept: boolean }
  | { type: 'done'; model: string; profile: ModelProfile }
  | { type: 'error'; model: string; message: string }
  | { type: 'reverted'; model: string; profile: ModelProfile }
