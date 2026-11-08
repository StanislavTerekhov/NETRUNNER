import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { RuntimeStatus, SetupItem } from '../../shared/ipc'
import type { CatalogEntry } from './llamacpp'

const run = promisify(execFile)

/** Models NETRUNNER is configured and tested with, as Hugging Face download specs (owner/repo:QUANT). */
export const RECOMMENDED = {
  general: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
  agent: 'Qwen/Qwen3-Coder-Next-GGUF:Q4_K_M',
  embedding: 'Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0',
  // Converted by the llama.cpp team for its /v1/rerank endpoint.
  reranker: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0',
}

async function hasCommand(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 8000, windowsHide: true })
    return stdout.trim().split('\n')[0]
  } catch {
    return null
  }
}

type Roles = { general: string | null; agent: string | null; embedding: string | null; reranker?: string | null }

/** Pure part of the check, so it can be unit-tested without a runtime or a filesystem. */
export function evaluateSetup(input: {
  status: RuntimeStatus
  catalog: CatalogEntry[]
  roles: Roles
  opencodeBinary: boolean
  git: string | null
  gpu: string | null
  /** Path of the rg executable the agents will use, or null. */
  ripgrep?: string | null
}): SetupItem[] {
  const name = (id: string | null) => input.catalog.find(e => e.id === id)?.name ?? id ?? ''
  const agentEntry = input.catalog.find(e => e.id === input.roles.agent)
  const items: SetupItem[] = [
    {
      id: 'runtime',
      label: 'llama.cpp runtime',
      ok: input.status.reachable,
      required: true,
      detail: input.status.reachable ? `${input.status.version} · ${input.status.url}` : (input.status.error ?? 'not installed'),
      fix: input.status.reachable ? null : { kind: 'install-runtime' },
    },
    {
      id: 'general-model',
      label: 'General model (chat)',
      ok: !!input.roles.general,
      required: true,
      detail: input.roles.general ? `${name(input.roles.general)}` : 'no chat model installed',
      fix: input.roles.general ? null : { kind: 'pull', model: RECOMMENDED.general },
    },
    {
      id: 'agent-model',
      label: 'Agent model (tools)',
      ok: !!agentEntry,
      required: false,
      detail: agentEntry ? agentEntry.name : 'no model with tool calling for the agent engine',
      fix: agentEntry ? null : { kind: 'pull', model: RECOMMENDED.agent },
    },
    {
      id: 'embedding-model',
      label: 'Embedding model (memory)',
      ok: !!input.roles.embedding,
      required: false,
      detail: input.roles.embedding ? `${name(input.roles.embedding)}` : 'missing — project MEMORY unavailable',
      fix: input.roles.embedding ? null : { kind: 'pull', model: RECOMMENDED.embedding },
    },
    {
      id: 'reranker-model',
      label: 'Reranker (memory search)',
      ok: !!input.roles.reranker,
      required: false,
      detail: input.roles.reranker ? name(input.roles.reranker) : 'missing — memory search uses words + embeddings only',
      fix: input.roles.reranker ? null : { kind: 'pull', model: RECOMMENDED.reranker },
    },
    { id: 'opencode', label: 'OpenCode agent engine', ok: input.opencodeBinary, required: true, detail: input.opencodeBinary ? 'bundled' : 'binary missing — reinstall NETRUNNER', fix: null },
    { id: 'git', label: 'Git', ok: !!input.git, required: false, detail: input.git ?? 'not found — agent checkpoints and diff review need Git for Windows', fix: null },
    {
      id: 'ripgrep',
      label: 'ripgrep (agent search)',
      ok: !!input.ripgrep,
      required: false,
      detail: input.ripgrep ?? "not found — the agents' grep/glob tools do not work offline",
      fix: input.ripgrep ? null : { kind: 'install-ripgrep' },
    },
    { id: 'gpu', label: 'NVIDIA GPU', ok: !!input.gpu, required: false, detail: input.gpu ?? 'nvidia-smi not found — models run on CPU (slow); GPU metrics unavailable', fix: null },
  ]
  return items
}

export async function checkSetup(deps: {
  status: () => Promise<RuntimeStatus>
  catalog: () => Promise<CatalogEntry[]>
  roles: Roles
  opencodeBinary: string
  ripgrep: string | null
}): Promise<SetupItem[]> {
  const [status, catalog, git, gpu] = await Promise.all([
    deps.status(),
    deps.catalog().catch(() => []),
    hasCommand('git', ['--version']),
    hasCommand('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']),
  ])
  return evaluateSetup({ status, catalog, roles: deps.roles, opencodeBinary: fs.existsSync(deps.opencodeBinary), git, gpu, ripgrep: deps.ripgrep })
}
