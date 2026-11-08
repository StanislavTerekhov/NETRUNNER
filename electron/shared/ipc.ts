import type { RiState } from './ri'
import type { AutotuneEvent, ModelProfile } from './autotune'
export type { AutotuneEvent, BenchResult, LaunchProfile, ModelProfile } from './autotune'
export type { RiFinding, RiKind, RiResource, RiState } from './ri'

// Typed IPC contract shared by main, preload and renderer.
// Every channel the renderer may use is listed here; main registers handlers only for these.

export interface DirEntry {
  name: string
  /** Path relative to the workspace root, always with forward slashes. */
  path: string
  kind: 'file' | 'dir'
}

export interface FileContent {
  path: string
  content: string
  size: number
  mtimeMs: number
}

export interface WorkspaceInfo {
  root: string
  name: string
}

export interface WindowState {
  maximized: boolean
  focused: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userData: string
}

/**
 * STRICT_OFFLINE: nothing leaves the machine (model downloads refused).
 * LOCAL_NETWORK: runtimes on the LAN may be used; still no internet actions.
 * ONLINE_TOOLS: explicitly enabled internet tools (model downloads). Inference stays local in every mode.
 */
export type NetworkMode = 'strict-offline' | 'local-network' | 'online-tools'

export interface Settings {
  recentWorkspaces: string[]
  lastWorkspace: string | null
  networkMode: NetworkMode
  /** Model ids are GGUF paths relative to the models folder. null = pick automatically. */
  defaultModel: string | null
  agentModel: string | null
  embeddingModel: string | null
  /** LM Studio models folder chosen by the user; null = detect automatically. */
  lmStudioDir: string | null
  /** Agent jobs that may run at the same time (1–4); above 1 editing jobs run in git worktrees. */
  agentLanes: number
  /** Workspace layouts saved by the user (built-in presets live in the renderer). */
  layouts: WorkspaceLayout[]
  /** Id of the active layout (built-in or saved). */
  activeLayout: string
  /** Interface language (models answer in the language of the question either way). */
  language: UiLanguage
  /**
   * How memory search ranks: 'vector' (embeddings; default — best on the 26-question test with every embedding size),
   * 'hybrid' (embeddings + word index; helps exact identifiers), 'rerank' (hybrid re-scored by the reranker, ~1 s).
   */
  memorySearch: MemorySearchMode
  /** How the chat writes code blocks that name a file into the workspace (see ChatFileWrites). */
  chatFileWrites: ChatFileWrites
  /**
   * Web tools of the chat and the agents (search, read pages, clone/install/run repositories; ONLINE TOOLS only):
   * ask — every action confirmed; limited — search and reading at once, clone/install/run confirmed; full — no questions.
   */
  webTools: ChatFileWrites
  /** Search provider; DuckDuckGo (no key) is always the fallback. */
  webSearch: { provider: WebSearchProvider; searxngUrl: string | null }
  /** Which API keys are stored (encrypted with Windows DPAPI); the keys never reach the renderer. */
  webKeys: { brave: boolean; google: boolean }
  /** The operator's host rules for everything NETRUNNER starts (proxy and web tools), on top of the network mode. */
  netRules: NetRules
  /** Programs whose internet access Windows Firewall should block (applied by the operator, with UAC). */
  firewall: { blocked: string[]; custom: string[] }
  /**
   * Fast mode of MoE models (NSC stage 6): model id → experts used per token, fewer than trained. Faster, and the
   * quality may drop; Qwen3-Coder-Next 10 → 8 was +19% generation with benchmark scores within noise.
   */
  fastExperts: Record<string, number>
  /** VRAM saver of MoE models (NSC-ME phase 6): ids of models that keep all experts in RAM (--cpu-moe). */
  vramSaver: string[]
  /**
   * Unloading idle models (NSC-ME phase 3), minutes without use; 0 = never. Small models (≤ 6 GiB of weights) come back
   * in ≤ 9 s even from disk; large ones in ~8 s from the Windows file cache but up to ~100 s from this PC's SATA disk.
   */
  idleUnload: { smallMinutes: number; largeMinutes: number }
}

/**
 * Host rules: `block` always wins (every mode); with `allowOnly` on, ONLINE TOOLS reaches only the hosts in
 * `allow`. "example.com" covers its subdomains, "*.example.com" only them. Loopback is never affected.
 */
export interface NetRules {
  block: string[]
  allow: string[]
  allowOnly: boolean
}

export type WebSearchProvider = 'duckduckgo' | 'searxng' | 'brave' | 'google'

/** One tool call made by the model while answering in the chat. */
export interface ChatToolStep {
  id: string
  name: string
  /** Arguments as the model sent them (JSON text). */
  args: string
  status: 'running' | 'done' | 'error'
  /** What the tool returned, cut for display. */
  result?: string
}

/**
 * Chat file writes: 'ask' — only on SAVE, each time confirmed; 'limited' — new files are written when the answer
 * ends, overwriting an existing file is confirmed; 'full' — everything is written when the answer ends.
 */
export type ChatFileWrites = 'ask' | 'limited' | 'full'

/** A code block from a chat answer to be written as a whole file (path relative to the workspace). */
export interface ChatFileRequest {
  path: string
  content: string
  /** The block looks like an excerpt ("// ... existing code"): never written automatically. */
  partial: boolean
}

export interface ChatFileResult {
  path: string
  status: 'created' | 'overwritten' | 'unchanged' | 'pending' | 'undone' | 'error'
  /** Content before the write (null: the file did not exist), kept so the write can be undone. */
  previous: string | null
  error?: string
}

export type UiLanguage = 'en' | 'ru'

export type MemorySearchMode = 'vector' | 'hybrid' | 'rerank'

/** What the editor screen shows: explorer, the terminal (own section or docked) and the chat beside the code. */
export interface WorkspaceLayout {
  id: string
  name: string
  explorer: boolean
  terminal: 'section' | 'bottom' | 'right'
  chat: boolean
}

export interface ModelSourceInfo {
  source: 'netrunner' | 'lmstudio'
  /** Folder in use, or null when LM Studio's folder was not found. */
  dir: string | null
  /** The folder was chosen by the user rather than detected. */
  manual: boolean
  models: number
}

// ---------- Local AI runtime ----------

export interface RuntimeStatus {
  backend: 'llama.cpp'
  url: string
  reachable: boolean
  version: string | null
  error: string | null
}

export interface ModelInfo {
  /** Model id (GGUF path relative to the models folder). */
  name: string
  /** Human-readable name derived from the file name. */
  label: string
  /** NETRUNNER's own models folder, or LM Studio's folder read in place (ids start with "lmstudio:"). */
  source: 'netrunner' | 'lmstudio'
  kind: 'chat' | 'embedding' | 'reranker'
  sizeBytes: number
  modifiedAt: string
  digest: string
  family: string | null
  parameterSize: string | null
  quantization: string | null
}

/** Placement llama.cpp itself plans for a model on this machine right now (llama-fit-params, free VRAM). */
export interface FitPlan {
  /** Repeating layers on the GPU, and how many the model has. */
  gpuLayers: number
  totalLayers: number
  /** Layers whose MoE expert weights stay in system RAM (the rest of those layers is on the GPU). */
  cpuExpertLayers: number
  ctx: number
}

export interface ModelDetails {
  name: string
  capabilities: string[]
  contextLength: number | null
  architecture: string | null
  parameterCount: number | null
  license: string | null
  template: string | null
  parameters: string | null
  /** MoE models: experts in each layer and used per token (as trained). */
  experts?: { total: number; used: number } | null
}

export interface RunningModel {
  name: string
  sizeBytes: number
  sizeVramBytes: number
  contextLength: number | null
  expiresAt: string
}

export interface GpuInfo {
  name: string
  vramTotalBytes: number
  vramUsedBytes: number
  utilizationPct: number | null
  driver: string | null
}

export interface HardwareInfo {
  cpuModel: string
  cpuThreads: number
  ramTotalBytes: number
  ramFreeBytes: number
  gpus: GpuInfo[]
  /** Explains missing GPU data instead of inventing it. */
  gpuError: string | null
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
  thinking?: string
  /** Attached pictures as data URLs (PNG/JPEG/WebP); need a model with a vision projector (mmproj). */
  images?: string[]
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  /** null: model has no thinking capability, the field is omitted. */
  think: boolean | null
  contextLength: number | null
  temperature: number | null
  /** WEB: the model may call the web tools (search, read pages, repositories) while it answers. */
  web?: boolean
}

export interface ChatMetrics {
  promptTokens: number
  outputTokens: number
  promptMs: number
  evalMs: number
  loadMs: number
  totalMs: number
  tokensPerSecond: number
}

export interface ChatChunk {
  streamId: string
  content: string
  thinking: string
  done: boolean
  error: string | null
  metrics: ChatMetrics | null
  /** Model that actually answers: the agent model while the agent engine holds the GPU, otherwise the requested one. */
  servedModel?: string
  /** A tool call started or finished (the same id is sent again with the result). */
  tool?: ChatToolStep
}

export interface PullProgress {
  pullId: string
  model: string
  status: string
  completedBytes: number | null
  totalBytes: number | null
  done: boolean
  error: string | null
}

export interface Conversation {
  id: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  systemPrompt: string
  /** `model`: the model that actually answered (set when it differs, e.g. the agent model while agents run). */
  messages: (ChatMessage & { metrics?: ChatMetrics | null; error?: string | null; model?: string; files?: ChatFileResult[]; tools?: ChatToolStep[] })[]
}

export interface ConversationSummary {
  id: string
  title: string
  model: string
  updatedAt: string
  messageCount: number
}

/** One FORGE pipeline step run from the UI (setup installs the Python environment, ONLINE TOOLS only). */
export type ForgeStep = 'setup' | 'dataset' | 'train' | 'merge' | 'export' | 'export-base' | 'evaluate' | 'bench'

export interface ForgeStartRequest {
  run: string
  steps: ForgeStep[]
  /** Workspace the dataset is built from. */
  workspace: string
  /** Limit dataset chunks (quick trial runs); undefined = all. */
  maxChunks?: number
  epochs?: number
  /** File stem of the exported GGUF in models/netrunner (default netrunner-<run>). */
  exportName?: string
}

export interface ForgeJob {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  run: string | null
  steps: ForgeStep[]
  current: ForgeStep | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  /** Last lines of the scripts' output. */
  log: string[]
}

export interface ForgeEnv {
  home: string
  systemPython: string | null
  venv: boolean
  convertVenv: boolean
  converter: boolean
  quantize: boolean
  baseWeights: boolean
  scripts: boolean
}

/** Summary of a FORGE fine-tuning run, read from the reports the pipeline wrote. Missing steps are null. */
export interface ForgeRun {
  name: string
  dir: string
  dataset: { trainSamples: number; evalSamples: number; teacher: string; workspace: string; chunks: number } | null
  training: {
    base: string
    epochs: number
    loraRank: number
    evalLossBefore: number
    evalLossAfter: number
    trainSeconds: number
    peakVramGb: number
  } | null
  evaluation: {
    baseModel: string
    tunedModel: string
    judgeModel: string
    questions: number
    baseJudgeMean: number
    tunedJudgeMean: number
    tunedWins: number
    ties: number
    baseWins: number
  } | null
  /** Standard benchmarks (bench.py), percent per suite for the base and the tuned model. */
  bench: { baseModel: string; tunedModel: string; suites: { suite: string; n: number; base: number; tuned: number }[] } | null
  /** Exported GGUF registered in the models folder, if any. */
  exportedModel: string | null
}

// ---------- Network log ----------

export interface NetLogEntry {
  id: number
  time: string
  source: string
  method: string
  host: string
  port: number
  allowed: boolean
  reason: string
}

// ---------- Terminal ----------

export interface PtyInfo {
  id: string
  shell: string
  cwd: string
}

// ---------- Git ----------

export interface GitFileStatus {
  path: string
  /** Two-letter porcelain code, e.g. " M", "??", "A ". */
  code: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  head: string | null
  files: GitFileStatus[]
}

export interface Checkpoint {
  ref: string
  commit: string
  label: string
  time: string
}

export interface ChangedFile {
  path: string
  /** A added, M modified, D deleted (relative to the checkpoint). */
  status: 'A' | 'M' | 'D'
}

export interface FileVersions {
  path: string
  original: string
  modified: string
}

// ---------- Agents (OpenCode) ----------

export type AgentRole = 'architect' | 'coder' | 'debugger' | 'reviewer' | 'operator'

export interface AgentEngineState {
  status: 'stopped' | 'starting' | 'running' | 'error'
  url: string | null
  workspace: string | null
  model: string | null
  version: string | null
  error: string | null
  /** Agent jobs the engine was started for (llama-server slots); changing it needs an engine restart. */
  lanes: number
}

export interface AgentSessionInfo {
  id: string
  title: string
  created: number
  updated: number
}

export type AgentPart =
  | { kind: 'text'; id: string; messageId: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'reasoning'; id: string; messageId: string; text: string }
  | {
      kind: 'tool'
      id: string
      messageId: string
      tool: string
      status: 'pending' | 'running' | 'completed' | 'error'
      title: string
      input: Record<string, unknown>
      output: string
      error: string | null
    }

export interface AgentPermission {
  id: string
  sessionId: string
  type: string
  title: string
  pattern: string[]
  metadata: Record<string, unknown>
}

/** A standing ALWAYS approval: exactly one command, file or pattern set, until the engine stops or it is revoked. */
export interface AgentGrant {
  key: string
  type: string
  /** The exact command / file / patterns it covers. */
  what: string
  /** Requests it has answered automatically. */
  uses: number
  since: string
}

export type AgentEvent =
  | { type: 'engine'; state: AgentEngineState }
  /** A request answered by a standing ALWAYS approval (no card; shown in the feed). */
  | { type: 'permission-auto'; sessionId: string; permission: AgentPermission; grant: AgentGrant }
  | { type: 'part'; sessionId: string; part: AgentPart }
  | { type: 'status'; sessionId: string; busy: boolean; detail: string | null }
  | { type: 'permission'; permission: AgentPermission }
  | { type: 'permission-replied'; sessionId: string; permissionId: string; response: string }
  | { type: 'error'; sessionId: string | null; message: string }
  | { type: 'tokens'; sessionId: string; input: number; output: number }

export interface AgentPromptRequest {
  sessionId: string
  text: string
  role: AgentRole
}

// ---------- Memory (semantic code search) ----------

export interface MemoryStatus {
  workspace: string
  model: string | null
  dims: number | null
  files: number
  chunks: number
  indexedAt: string | null
  indexing: boolean
  configuredModel: string
}

export interface MemoryProgress {
  workspace: string
  phase: 'scanning' | 'embedding' | 'done' | 'error'
  filesTotal: number
  filesDone: number
  filesSkipped: number
  filesRemoved: number
  chunksEmbedded: number
  error: string | null
  seconds: number
}

export interface MemoryHit {
  path: string
  startLine: number
  endLine: number
  content: string
  /** Cosine similarity, 1 = identical direction. */
  score: number
}

// ---------- Task queue ----------

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface AgentTask {
  id: number
  role: AgentRole
  prompt: string
  status: TaskStatus
  useMemory: boolean
  pipelineId: string | null
  pipelineStep: number | null
  sessionId: string | null
  checkpoint: string | null
  result: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** A single task or a whole pipeline; steps of one job run one after another. */
  jobId: string
  /** Set when the job runs in its own git worktree (parallel agents). */
  worktree: AgentJob | null
}

/**
 * A job isolated in a git worktree. active → working; ready → finished with changes, waiting for MERGE or
 * DISCARD; empty → finished without changes (worktree removed); merged / discarded → worktree removed.
 */
export interface AgentJob {
  id: string
  path: string
  base: string
  state: 'active' | 'ready' | 'empty' | 'merged' | 'discarded'
  changes: number | null
  /** Workspace checkpoint taken right before the merge (review / revert it in GIT). */
  mergeCheckpoint: string | null
  conflicts: string[]
}

export interface EnqueueRequest {
  role: AgentRole
  prompt: string
  useMemory: boolean
}

// ---------- Telemetry (phase 5) ----------

export interface GpuSample {
  name: string
  utilizationPct: number | null
  vramUsedBytes: number
  vramTotalBytes: number
  temperatureC: number | null
  powerW: number | null
  powerLimitW: number | null
  clockMhz: number | null
}

export interface ProcessSample {
  name: string
  pids: number
  cpuPct: number
  memBytes: number
}

export interface DiskSample {
  mount: string
  usedBytes: number
  sizeBytes: number
}

/** One telemetry sample. Fields are null when the platform does not provide the value. */
export interface TelemetrySample {
  time: number
  cpuPct: number
  cpuCores: number[]
  cpuModel: string
  cpuTempC: number | null
  ramUsedBytes: number
  ramTotalBytes: number
  gpus: GpuSample[]
  gpuError: string | null
  processes: ProcessSample[] | null
  disks: DiskSample[] | null
  netRxBps: number | null
  netTxBps: number | null
  appMemBytes: number
}

export interface InferenceMetric {
  id: number
  time: string
  /** chat: NEURAL CORE reply (llama-server timings); agent: one agent task (llama-server token counters). */
  source: 'chat' | 'agent'
  model: string
  promptTokens: number
  outputTokens: number
  tokensPerSecond: number
  promptMs: number
  loadMs: number
  totalMs: number
}

export interface ModelPerf {
  model: string
  runs: number
  avgTokensPerSecond: number
  bestTokensPerSecond: number
  avgPromptTokensPerSecond: number
  avgLoadMs: number
}

export interface TaskPerf {
  role: AgentRole
  runs: number
  done: number
  failed: number
  avgSeconds: number
  /** Measured generation speed of this role's tasks (llama-server counters), null before the first measurement. */
  avgTokensPerSecond: number | null
}

/** One program in the FIREWALL list: NETRUNNER's own (builtin) or one the operator added. */
export interface FirewallProgram {
  path: string
  label: string
  builtin: boolean
  /** The operator wants its internet access blocked. */
  wanted: boolean
  /** A NETRUNNER rule for it is in Windows Firewall now. */
  active: boolean
  exists: boolean
}

export interface FirewallStatus {
  supported: boolean
  programs: FirewallProgram[]
  /** Wanted and active differ for some program: APPLY would change Windows Firewall. */
  pending: boolean
  detail: string
}

/** Model id per role after applying settings and automatic choice (null = no suitable model installed). */
export interface ModelRoles {
  general: string | null
  agent: string | null
  embedding: string | null
}

export interface SetupItem {
  id: string
  label: string
  ok: boolean
  /** Required items block core features; optional ones only limit something. */
  required: boolean
  detail: string
  /** Something the UI can do about it. */
  fix: { kind: 'pull'; model: string } | { kind: 'install-runtime' } | { kind: 'install-ripgrep' } | null
}

/** Request channels: renderer → main, with a response. */
export interface InvokeChannels {
  'window:minimize': { args: []; result: void }
  'window:toggle-maximize': { args: []; result: WindowState }
  'window:close': { args: []; result: void }
  'window:get-state': { args: []; result: WindowState }
  'app:info': { args: []; result: AppInfo }
  'settings:get': { args: []; result: Settings }
  'settings:set-network-mode': { args: [mode: NetworkMode]; result: Settings }
  'settings:set-default-model': { args: [model: string | null]; result: Settings }
  'workspace:pick': { args: []; result: WorkspaceInfo | null }
  'workspace:open': { args: [root: string]; result: WorkspaceInfo }
  'workspace:current': { args: []; result: WorkspaceInfo | null }
  'fs:list': { args: [relPath: string]; result: DirEntry[] }
  'fs:read': { args: [relPath: string]; result: FileContent }
  'fs:write': { args: [relPath: string, content: string, expectedMtimeMs: number | null]; result: FileContent }
  'runtime:status': { args: []; result: RuntimeStatus }
  'models:list': { args: []; result: ModelInfo[] }
  'models:details': { args: [name: string]; result: ModelDetails }
  'models:running': { args: []; result: RunningModel[] }
  'models:load': { args: [name: string]; result: void }
  'models:unload': { args: [name: string]; result: void }
  'models:delete': { args: [name: string]; result: void }
  'models:pull': { args: [name: string]; result: string }
  'models:pull-cancel': { args: [pullId: string]; result: void }
  'hardware:info': { args: []; result: HardwareInfo }
  'chat:start': { args: [request: ChatRequest]; result: string }
  'chat:stop': { args: [streamId: string]; result: void }
  'conversations:list': { args: []; result: ConversationSummary[] }
  'conversations:get': { args: [id: string]; result: Conversation }
  'conversations:save': { args: [conversation: Conversation]; result: void }
  'conversations:delete': { args: [id: string]; result: void }
  'forge:runs': { args: []; result: ForgeRun[] }
  'network:log': { args: []; result: NetLogEntry[] }
  /** Bytes NETRUNNER itself moved since it started, by source (proxy, web tools, downloads). */
  'network:traffic': { args: []; result: { source: string; sent: number; received: number; connections: number }[] }
  'pty:create': { args: []; result: PtyInfo }
  'pty:write': { args: [id: string, data: string]; result: void }
  'pty:resize': { args: [id: string, cols: number, rows: number]; result: void }
  'pty:kill': { args: [id: string]; result: void }
  'git:status': { args: []; result: GitStatus }
  'git:init': { args: []; result: GitStatus }
  'git:checkpoints': { args: []; result: Checkpoint[] }
  'git:checkpoint': { args: [label: string]; result: Checkpoint }
  'git:changes': { args: [commit: string]; result: ChangedFile[] }
  'git:file-versions': { args: [commit: string, path: string]; result: FileVersions }
  'git:restore': { args: [commit: string]; result: void }
  'agent:state': { args: []; result: AgentEngineState }
  'agent:start': { args: [model: string]; result: AgentEngineState }
  'agent:stop': { args: []; result: AgentEngineState }
  'agent:sessions': { args: []; result: AgentSessionInfo[] }
  'agent:create-session': { args: [title: string]; result: AgentSessionInfo }
  'agent:history': { args: [sessionId: string]; result: AgentPart[] }
  'agent:prompt': { args: [req: AgentPromptRequest]; result: void }
  'agent:abort': { args: [sessionId: string]; result: void }
  'agent:grants': { args: []; result: AgentGrant[] }
  'agent:revoke-grant': { args: [key: string]; result: AgentGrant[] }
  'agent:respond': { args: [sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject']; result: void }
  'memory:status': { args: []; result: MemoryStatus }
  'memory:index': { args: []; result: MemoryProgress }
  'memory:clear': { args: []; result: MemoryStatus }
  'memory:search': { args: [query: string, k: number]; result: MemoryHit[] }
  'tasks:list': { args: []; result: AgentTask[] }
  'tasks:enqueue': { args: [req: EnqueueRequest]; result: AgentTask }
  'tasks:pipeline': { args: [goal: string, useMemory: boolean]; result: AgentTask[] }
  'tasks:cancel': { args: [id: number]; result: AgentTask }
  'tasks:retry': { args: [id: number]; result: AgentTask }
  'telemetry:subscribe': { args: []; result: void }
  'telemetry:unsubscribe': { args: []; result: void }
  'ri:get': { args: []; result: RiState }
  'autotune:run': { args: [model: string]; result: ModelProfile }
  'autotune:get': { args: [model: string]; result: ModelProfile | null }
  'autotune:list': { args: []; result: ModelProfile[] }
  'autotune:reset': { args: [model: string]; result: void }
  'metrics:inference': { args: [limit: number]; result: { recent: InferenceMetric[]; perModel: ModelPerf[] } }
  'metrics:tasks': { args: []; result: TaskPerf[] }
  'network:clear': { args: []; result: void }
  'network:csp-violation': { args: [blockedUrl: string, directive: string]; result: void }
  'firewall:status': { args: []; result: FirewallStatus }
  /** Writes the wanted rules to Windows Firewall (elevated PowerShell, Windows asks with UAC); 'clear' removes them all. */
  'firewall:apply': { args: [what: 'sync' | 'clear']; result: FirewallStatus }
  'firewall:set-program': { args: [path: string, wanted: boolean]; result: FirewallStatus }
  /** Opens a file dialog in the main process; the chosen .exe joins the list (not yet blocked). */
  'firewall:add-program': { args: []; result: FirewallStatus }
  'firewall:remove-program': { args: [path: string]; result: FirewallStatus }
  'settings:set-net-rules': { args: [rules: NetRules]; result: Settings }
  'setup:check': { args: []; result: SetupItem[] }
  'setup:install-runtime': { args: []; result: string }
  /** ONLINE TOOLS: the installed llama.cpp build against the newest one with Windows x64 binaries. */
  'runtime:check-update': { args: []; result: { installed: string | null; latest: string; publishedAt: string | null; newer: boolean } }
  'models:roles': { args: []; result: ModelRoles }
  'settings:set-agent-model': { args: [model: string | null]; result: Settings }
  'settings:set-embedding-model': { args: [model: string | null]; result: Settings }
  /** 'pick' opens a folder dialog in the main process; 'auto' returns to detection. */
  'settings:set-lmstudio-dir': { args: [mode: 'pick' | 'auto']; result: Settings }
  'settings:set-agent-lanes': { args: [lanes: number]; result: Settings }
  'settings:set-fast-experts': { args: [model: string, experts: number | null]; result: Settings }
  'settings:set-vram-saver': { args: [model: string, on: boolean]; result: Settings }
  'settings:set-idle-unload': { args: [smallMinutes: number, largeMinutes: number]; result: Settings }
  'settings:set-layouts': { args: [layouts: WorkspaceLayout[], active: string]; result: Settings }
  'models:sources': { args: []; result: ModelSourceInfo[] }
  'tasks:job-changes': { args: [jobId: string]; result: ChangedFile[] }
  'tasks:merge-job': { args: [jobId: string]; result: AgentJob }
  'tasks:discard-job': { args: [jobId: string]; result: AgentJob }
  'pty:buffer': { args: [id: string]; result: string | null }
  'setup:install-ripgrep': { args: []; result: string }
  /** Generation speed of the agent model since the previous call (null when nothing was generated). */
  'metrics:agent-live': { args: []; result: { tokensPerSecond: number | null; outputTokens: number } }
  'conversations:search': { args: [query: string]; result: (ConversationSummary & { snippet: string })[] }
  /** Editor language servers: open/change/close a document, ask for one feature at a position. */
  'lsp:open': { args: [path: string, languageId: string, text: string]; result: boolean }
  'lsp:change': { args: [path: string, text: string]; result: void }
  'lsp:close': { args: [path: string]; result: void }
  'lsp:saved': { args: [path: string]; result: void }
  'lsp:request': { args: [path: string, feature: 'completion' | 'hover' | 'definition' | 'signatureHelp', position: { line: number; character: number }]; result: unknown }
  'lsp:status': { args: []; result: { id: string; label: string; languages: string[]; state: string; detail: string | null }[] }
  'settings:set-language': { args: [language: UiLanguage]; result: Settings }
  'settings:set-memory-search': { args: [mode: MemorySearchMode]; result: Settings }
  'settings:set-chat-file-writes': { args: [mode: ChatFileWrites]; result: Settings }
  'settings:set-web-tools': { args: [mode: ChatFileWrites]; result: Settings }
  'settings:set-web-search': { args: [provider: WebSearchProvider, searxngUrl: string | null]; result: Settings }
  /** Stores (or with null removes) an API key, encrypted; Google needs the search engine id (cx) as well. */
  'settings:set-web-key': { args: [which: 'brave' | 'google', key: string | null, cx?: string | null]; result: Settings }
  /** trigger 'auto': after an answer ends (the mode decides what is written); 'manual': the SAVE button. */
  'chat:write-files': { args: [files: ChatFileRequest[], trigger: 'auto' | 'manual']; result: ChatFileResult[] }
  /** Restores the content before a chat write; a file the chat created goes to the recycle bin. */
  'chat:undo-files': { args: [writes: { path: string; previous: string | null; expected: string }[]]; result: ChatFileResult[] }
  'models:fit': { args: [name: string]; result: FitPlan | null }
  'forge:env': { args: []; result: ForgeEnv }
  'forge:start': { args: [req: ForgeStartRequest]; result: ForgeJob }
  'forge:cancel': { args: []; result: ForgeJob }
  'forge:state': { args: []; result: ForgeJob }
  /** Opens a save dialog in the main process; returns the written path, or null when cancelled. */
  'conversations:export': { args: [id: string, format: 'md' | 'json']; result: string | null }
  'fs:create': { args: [relPath: string, kind: 'file' | 'dir']; result: DirEntry }
  'fs:rename': { args: [fromPath: string, toPath: string]; result: string }
  /** Moves to the recycle bin after a confirmation in the main process. */
  'fs:delete': { args: [relPath: string]; result: void }
}

/** Event channels: main → renderer. */
export interface EventChannels {
  'window:state': WindowState
  'chat:chunk': ChatChunk
  'models:pull-progress': PullProgress
  'pty:data': { id: string; data: string }
  'pty:exit': { id: string; code: number }
  'agent:event': AgentEvent
  'network:entry': NetLogEntry
  'memory:progress': MemoryProgress
  'tasks:changed': AgentTask[]
  'telemetry:sample': TelemetrySample
  /** Reverse-interference monitor: findings and resource shares, after every sample while a model is loaded. */
  'ri:state': RiState
  /** Autotuner progress (each measured candidate) and automatic rollbacks. */
  'autotune:event': AutotuneEvent
  /** Workspace-relative paths changed on disk (by anyone), batched. */
  'fs:changed': string[]
  /** LSP diagnostics for one workspace file (raw LSP Diagnostic objects). */
  'lsp:diagnostics': { path: string; diagnostics: unknown[] }
  /** FORGE job state; `line` is a new output line (null for a state change only). */
  'forge:event': { job: ForgeJob; line: string | null }
}

export type InvokeChannel = keyof InvokeChannels
export type EventChannel = keyof EventChannels

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'window:get-state',
  'app:info',
  'settings:get',
  'settings:set-network-mode',
  'settings:set-default-model',
  'workspace:pick',
  'workspace:open',
  'workspace:current',
  'fs:list',
  'fs:read',
  'fs:write',
  'runtime:status',
  'models:list',
  'models:details',
  'models:running',
  'models:load',
  'models:unload',
  'models:delete',
  'models:pull',
  'models:pull-cancel',
  'hardware:info',
  'chat:start',
  'chat:stop',
  'conversations:list',
  'conversations:get',
  'conversations:save',
  'conversations:delete',
  'forge:runs',
  'network:log',
  'network:traffic',
  'pty:create',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'git:status',
  'git:init',
  'git:checkpoints',
  'git:checkpoint',
  'git:changes',
  'git:file-versions',
  'git:restore',
  'agent:state',
  'agent:start',
  'agent:stop',
  'agent:sessions',
  'agent:create-session',
  'agent:history',
  'agent:prompt',
  'agent:abort',
  'agent:respond',
  'agent:grants',
  'agent:revoke-grant',
  'memory:status',
  'memory:index',
  'memory:clear',
  'memory:search',
  'tasks:list',
  'tasks:enqueue',
  'tasks:pipeline',
  'tasks:cancel',
  'tasks:retry',
  'telemetry:subscribe',
  'telemetry:unsubscribe',
  'ri:get',
  'autotune:run',
  'autotune:get',
  'autotune:list',
  'autotune:reset',
  'metrics:inference',
  'metrics:tasks',
  'network:clear',
  'network:csp-violation',
  'firewall:status',
  'firewall:apply',
  'firewall:set-program',
  'firewall:add-program',
  'firewall:remove-program',
  'settings:set-net-rules',
  'setup:check',
  'runtime:check-update',
  'setup:install-runtime',
  'models:roles',
  'settings:set-agent-model',
  'settings:set-embedding-model',
  'settings:set-lmstudio-dir',
  'settings:set-agent-lanes',
  'settings:set-fast-experts',
  'settings:set-vram-saver',
  'settings:set-idle-unload',
  'settings:set-layouts',
  'models:sources',
  'tasks:job-changes',
  'tasks:merge-job',
  'tasks:discard-job',
  'pty:buffer',
  'setup:install-ripgrep',
  'metrics:agent-live',
  'conversations:search',
  'conversations:export',
  'lsp:open',
  'lsp:change',
  'lsp:close',
  'lsp:saved',
  'lsp:request',
  'lsp:status',
  'settings:set-language',
  'settings:set-memory-search',
  'settings:set-chat-file-writes',
  'settings:set-web-tools',
  'settings:set-web-search',
  'settings:set-web-key',
  'chat:write-files',
  'chat:undo-files',
  'models:fit',
  'forge:env',
  'forge:start',
  'forge:cancel',
  'forge:state',
  'fs:create',
  'fs:rename',
  'fs:delete',
]

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'window:state',
  'chat:chunk',
  'models:pull-progress',
  'pty:data',
  'pty:exit',
  'agent:event',
  'network:entry',
  'memory:progress',
  'tasks:changed',
  'telemetry:sample',
  'ri:state',
  'autotune:event',
  'fs:changed',
  'lsp:diagnostics',
  'forge:event',
]

/** API exposed on window.netrunner by the preload script. */
export interface NetrunnerApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeChannels[C]['args']): Promise<InvokeChannels[C]['result']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventChannels[C]) => void): () => void
}
