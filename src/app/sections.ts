import {
  Activity,
  Bot,
  BrainCircuit,
  Code2,
  Database,
  FolderGit2,
  FolderOpen,
  Flame,
  Network,
  SquareTerminal,
  Vault,
  type LucideIcon,
} from 'lucide-react'
import type { SectionId } from './store'

/** Highest build phase that is implemented in this version. */
export const CURRENT_PHASE = 5

export interface SectionDef {
  id: SectionId
  label: string
  /** Caption under the icon in the navigation rail (one short word). */
  short: string
  icon: LucideIcon
  /** Phase in which the section becomes functional. */
  phase: number
  summary: string
}

export const isAvailable = (s: SectionDef) => s.phase <= CURRENT_PHASE

export const SECTIONS: SectionDef[] = [
  { id: 'workspace', label: 'WORKSPACE', short: 'PROJECT', icon: FolderOpen, phase: 1, summary: 'Open and switch project folders.' },
  { id: 'editor', label: 'CODE EDITOR', short: 'CODE', icon: Code2, phase: 1, summary: 'Monaco editor with real file access.' },
  { id: 'agents', label: 'AGENT CONTROL', short: 'AGENTS', icon: Bot, phase: 3, summary: 'OpenCode-driven agents: Architect, Coder, Debugger, Reviewer, Operator. Approvals and diff review.' },
  { id: 'neural', label: 'NEURAL CORE', short: 'CHAT', icon: BrainCircuit, phase: 2, summary: 'Streaming chat with local GGUF models through llama.cpp.' },
  { id: 'models', label: 'MODEL VAULT', short: 'MODELS', icon: Vault, phase: 2, summary: 'Installed local models, hardware-aware recommendations, load/unload, pulls in online mode, FORGE runs.' },
  { id: 'terminal', label: 'TERMINAL', short: 'TERMINAL', icon: SquareTerminal, phase: 3, summary: 'PowerShell via node-pty in the main process, rendered with xterm.js.' },
  { id: 'memory', label: 'MEMORY', short: 'MEMORY', icon: Database, phase: 4, summary: 'SQLite history and sqlite-vec semantic code search with local embeddings.' },
  { id: 'git', label: 'GIT', short: 'GIT', icon: FolderGit2, phase: 3, summary: 'Status, diffs and agent checkpoints.' },
  { id: 'system', label: 'SYSTEM MONITOR', short: 'SYSTEM', icon: Activity, phase: 5, summary: 'Measured CPU, RAM, disk, GPU and VRAM. No synthetic values.' },
  { id: 'forge', label: 'FORGE', short: 'FORGE', icon: Flame, phase: 5, summary: 'Local fine-tuning of Qwen weights on the open project: dataset, training, export, evaluation.' },
  { id: 'network', label: 'NETWORK MONITOR', short: 'NETWORK', icon: Network, phase: 5, summary: 'Network mode (Strict offline / LAN / Online tools) and a log of every outbound request.' },
]

export const sectionById = (id: SectionId) => SECTIONS.find(s => s.id === id)!
