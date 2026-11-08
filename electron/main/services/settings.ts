import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChatFileWrites, MemorySearchMode, NetRules, NetworkMode, Settings, UiLanguage, WebSearchProvider, WorkspaceLayout } from '../../shared/ipc'
import { cleanHostRule } from './endpoint-policy'

const NETWORK_MODES: NetworkMode[] = ['strict-offline', 'local-network', 'online-tools']
const FILE_WRITE_MODES: ChatFileWrites[] = ['ask', 'limited', 'full']
const SEARCH_MODES: MemorySearchMode[] = ['vector', 'hybrid', 'rerank']
const SEARCH_PROVIDERS: WebSearchProvider[] = ['duckduckgo', 'searxng', 'brave', 'google']

/** A SearXNG address: http(s) origin only (it is usually the user's own instance on loopback or the LAN). */
export function searxngAddress(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const u = new URL(v.trim())
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.origin : null
  } catch {
    return null
  }
}

const DEFAULTS: Settings = {
  recentWorkspaces: [],
  lastWorkspace: null,
  networkMode: 'strict-offline',
  defaultModel: null,
  agentModel: null,
  embeddingModel: null,
  lmStudioDir: null,
  agentLanes: 1,
  layouts: [],
  activeLayout: 'classic',
  language: 'en',
  memorySearch: 'vector',
  chatFileWrites: 'limited',
  webTools: 'limited',
  webSearch: { provider: 'duckduckgo', searxngUrl: null },
  webKeys: { brave: false, google: false },
  netRules: { block: [], allow: [], allowOnly: false },
  firewall: { blocked: [], custom: [] },
  fastExperts: {},
  vramSaver: [],
  // Small models (embeddings, 4B) are cheap to bring back; large ones stay until the operator chooses a time.
  idleUnload: { smallMinutes: 10, largeMinutes: 0 },
}

/** Allowed idle-unload times, minutes (0 = never). */
export const IDLE_MINUTES = [0, 5, 10, 30, 60, 120] as const
const idleMinutes = (v: unknown, fallback: number): number => (IDLE_MINUTES as readonly number[]).includes(v as number) ? (v as number) : fallback

/** Idle-unload settings as stored: only the allowed times. */
export function normalizeIdleUnload(v: unknown): Settings['idleUnload'] {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Settings['idleUnload']>
  return { smallMinutes: idleMinutes(o.smallMinutes, DEFAULTS.idleUnload.smallMinutes), largeMinutes: idleMinutes(o.largeMinutes, DEFAULTS.idleUnload.largeMinutes) }
}

const expertsUsed = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 256

/** Fast-mode entries as stored: .gguf model ids with a sane number of experts. */
export function normalizeFastExperts(v: unknown): Record<string, number> {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return Object.fromEntries(Object.entries(o).filter(([k, n]) => modelId(k) && expertsUsed(n))) as Record<string, number>
}

const MAX_RULES = 500

/** Host rules as stored: cleaned, without duplicates. */
export function normalizeNetRules(v: unknown): NetRules {
  const o = (v ?? {}) as Partial<NetRules>
  const list = (x: unknown) => [...new Set((Array.isArray(x) ? x : []).map(cleanHostRule).filter((s): s is string => !!s))].slice(0, MAX_RULES)
  return { block: list(o.block), allow: list(o.allow), allowOnly: o.allowOnly === true }
}

/** Absolute .exe paths only. */
const exeList = (x: unknown) => [...new Set((Array.isArray(x) ? x : []).filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && /\.exe$/i.test(p)))].slice(0, 100)
const MAX_RECENT = 10
export const MAX_LANES = 4
const MAX_LAYOUTS = 20

/** Model ids are GGUF paths relative to the models folder; Ollama-era tags ("qwen3:8b") are dropped. */
const modelId = (v: unknown): string | null => (typeof v === 'string' && /\.gguf$/i.test(v) ? v : null)

const lanes = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_LANES ? (v as number) : DEFAULTS.agentLanes)

const layoutId = (v: unknown): string | null => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null)

/** A saved layout, normalised; anything malformed is dropped. */
export function normalizeLayout(v: unknown): WorkspaceLayout | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = layoutId(o.id)
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : ''
  if (!id || !name) return null
  return {
    id,
    name,
    explorer: o.explorer !== false,
    terminal: o.terminal === 'bottom' || o.terminal === 'right' ? o.terminal : 'section',
    chat: o.chat === true,
  }
}

/** Small JSON settings store in the user data directory. Local only. */
export class SettingsStore {
  private data: Settings = structuredClone(DEFAULTS)
  private readonly file: string

  /** systemLanguage: used until the user picks one (Russian for a Russian Windows locale). */
  constructor(
    userDataDir: string,
    private readonly systemLanguage: () => UiLanguage = () => 'en',
  ) {
    this.file = path.join(userDataDir, 'settings.json')
  }

  async setMemorySearch(mode: MemorySearchMode): Promise<Settings> {
    if (!SEARCH_MODES.includes(mode)) throw new Error(`Unknown memory search mode: ${mode}`)
    this.data.memorySearch = mode
    await this.save()
    return this.get()
  }

  async setChatFileWrites(mode: ChatFileWrites): Promise<Settings> {
    if (!FILE_WRITE_MODES.includes(mode)) throw new Error(`Unknown file write mode: ${mode}`)
    this.data.chatFileWrites = mode
    await this.save()
    return this.get()
  }

  async setWebTools(mode: ChatFileWrites): Promise<Settings> {
    if (!FILE_WRITE_MODES.includes(mode)) throw new Error(`Unknown web tools mode: ${mode}`)
    this.data.webTools = mode
    await this.save()
    return this.get()
  }

  async setWebSearch(provider: WebSearchProvider, searxngUrl: string | null): Promise<Settings> {
    if (!SEARCH_PROVIDERS.includes(provider)) throw new Error(`Unknown search provider: ${provider}`)
    const url = searxngUrl === null || searxngUrl === '' ? null : searxngAddress(searxngUrl)
    if (searxngUrl && !url) throw new Error('SearXNG address must be an http(s) URL')
    this.data.webSearch = { provider, searxngUrl: url }
    await this.save()
    return this.get()
  }

  async setNetRules(rules: NetRules): Promise<Settings> {
    this.data.netRules = normalizeNetRules(rules)
    await this.save()
    return this.get()
  }

  async setFirewallPrograms(blocked: string[], custom: string[]): Promise<Settings> {
    this.data.firewall = { blocked: exeList(blocked), custom: exeList(custom) }
    await this.save()
    return this.get()
  }

  /** Only whether a key is stored; the keys themselves live in the encrypted secrets file. */
  async setWebKeyFlags(keys: { brave: boolean; google: boolean }): Promise<Settings> {
    this.data.webKeys = { brave: keys.brave === true, google: keys.google === true }
    await this.save()
    return this.get()
  }

  async setLanguage(lang: UiLanguage): Promise<Settings> {
    if (lang !== 'en' && lang !== 'ru') throw new Error(`Unsupported language: ${lang}`)
    this.data.language = lang
    await this.save()
    return this.get()
  }

  async load(): Promise<Settings> {
    try {
      // Strip a UTF-8 BOM: files edited with Windows tools (e.g. PowerShell 5.1) often carry one.
      const text = (await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')
      const parsed = JSON.parse(text) as Partial<Settings>
      this.data = {
        recentWorkspaces: Array.isArray(parsed.recentWorkspaces)
          ? parsed.recentWorkspaces.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT)
          : [],
        lastWorkspace: typeof parsed.lastWorkspace === 'string' ? parsed.lastWorkspace : null,
        networkMode: NETWORK_MODES.includes(parsed.networkMode as NetworkMode)
          ? (parsed.networkMode as NetworkMode)
          : DEFAULTS.networkMode,
        defaultModel: modelId(parsed.defaultModel),
        agentModel: modelId(parsed.agentModel),
        embeddingModel: modelId(parsed.embeddingModel),
        lmStudioDir: typeof parsed.lmStudioDir === 'string' && path.isAbsolute(parsed.lmStudioDir) ? parsed.lmStudioDir : null,
        agentLanes: lanes(parsed.agentLanes),
        layouts: Array.isArray(parsed.layouts)
          ? parsed.layouts.map(normalizeLayout).filter((l): l is WorkspaceLayout => l !== null).slice(0, MAX_LAYOUTS)
          : [],
        activeLayout: layoutId(parsed.activeLayout) ?? DEFAULTS.activeLayout,
        language: parsed.language === 'ru' || parsed.language === 'en' ? parsed.language : this.systemLanguage(),
        // Before 1.7 there was only an on/off reranker switch.
        memorySearch: SEARCH_MODES.includes(parsed.memorySearch as MemorySearchMode)
          ? (parsed.memorySearch as MemorySearchMode)
          : (parsed as { memoryRerank?: unknown }).memoryRerank === true
            ? 'rerank'
            : DEFAULTS.memorySearch,
        chatFileWrites: FILE_WRITE_MODES.includes(parsed.chatFileWrites as ChatFileWrites) ? (parsed.chatFileWrites as ChatFileWrites) : DEFAULTS.chatFileWrites,
        webTools: FILE_WRITE_MODES.includes(parsed.webTools as ChatFileWrites) ? (parsed.webTools as ChatFileWrites) : DEFAULTS.webTools,
        webSearch: {
          provider: SEARCH_PROVIDERS.includes(parsed.webSearch?.provider as WebSearchProvider) ? (parsed.webSearch!.provider as WebSearchProvider) : 'duckduckgo',
          searxngUrl: searxngAddress(parsed.webSearch?.searxngUrl),
        },
        webKeys: { brave: parsed.webKeys?.brave === true, google: parsed.webKeys?.google === true },
        netRules: normalizeNetRules(parsed.netRules),
        firewall: { blocked: exeList(parsed.firewall?.blocked), custom: exeList(parsed.firewall?.custom) },
        fastExperts: normalizeFastExperts(parsed.fastExperts),
        vramSaver: [...new Set((Array.isArray(parsed.vramSaver) ? parsed.vramSaver : []).filter(modelId))],
        idleUnload: normalizeIdleUnload(parsed.idleUnload),
      }
    } catch {
      this.data = { ...structuredClone(DEFAULTS), language: this.systemLanguage() }
    }
    return this.get()
  }

  get(): Settings {
    return structuredClone(this.data)
  }

  async rememberWorkspace(root: string): Promise<void> {
    this.data.lastWorkspace = root
    this.data.recentWorkspaces = [root, ...this.data.recentWorkspaces.filter(p => p !== root)].slice(0, MAX_RECENT)
    await this.save()
  }

  async setNetworkMode(mode: NetworkMode): Promise<Settings> {
    if (!NETWORK_MODES.includes(mode)) throw new Error(`Unknown network mode: ${mode}`)
    this.data.networkMode = mode
    await this.save()
    return this.get()
  }

  private async setModel(key: 'defaultModel' | 'agentModel' | 'embeddingModel', model: string | null): Promise<Settings> {
    if (model !== null && !modelId(model)) throw new Error('Model id must be a .gguf path')
    this.data[key] = model
    await this.save()
    return this.get()
  }

  setDefaultModel = (m: string | null) => this.setModel('defaultModel', m)
  setAgentModel = (m: string | null) => this.setModel('agentModel', m)
  setEmbeddingModel = (m: string | null) => this.setModel('embeddingModel', m)

  async setLmStudioDir(dir: string | null): Promise<Settings> {
    if (dir !== null && !path.isAbsolute(dir)) throw new Error('LM Studio folder must be an absolute path')
    this.data.lmStudioDir = dir
    await this.save()
    return this.get()
  }

  async setAgentLanes(n: number): Promise<Settings> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_LANES) throw new Error(`Parallel agents must be 1–${MAX_LANES}`)
    this.data.agentLanes = n
    await this.save()
    return this.get()
  }

  /** null = the model's own number of experts again. Applies at the next model load. */
  async setFastExperts(model: string, experts: number | null): Promise<Settings> {
    if (!modelId(model)) throw new Error('Model id must be a .gguf path')
    if (experts !== null && !expertsUsed(experts)) throw new Error('Experts per token must be a whole number 1–256')
    const next = { ...this.data.fastExperts }
    if (experts === null) delete next[model]
    else next[model] = experts
    this.data.fastExperts = next
    await this.save()
    return this.get()
  }

  /** VRAM saver of a MoE model (all experts in RAM). Applies at the next model load. */
  async setVramSaver(model: string, on: boolean): Promise<Settings> {
    if (!modelId(model)) throw new Error('Model id must be a .gguf path')
    this.data.vramSaver = on ? [...new Set([...this.data.vramSaver, model])] : this.data.vramSaver.filter(m => m !== model)
    await this.save()
    return this.get()
  }

  async setIdleUnload(smallMinutes: number, largeMinutes: number): Promise<Settings> {
    const ok = (n: number) => (IDLE_MINUTES as readonly number[]).includes(n)
    if (!ok(smallMinutes) || !ok(largeMinutes)) throw new Error(`Idle unload must be one of ${IDLE_MINUTES.join(', ')} minutes`)
    this.data.idleUnload = { smallMinutes, largeMinutes }
    await this.save()
    return this.get()
  }

  async setLayouts(layouts: unknown, active: unknown): Promise<Settings> {
    if (!Array.isArray(layouts) || layouts.length > MAX_LAYOUTS) throw new Error('Invalid layouts')
    const list = layouts.map(normalizeLayout)
    if (list.some(l => l === null)) throw new Error('Invalid layout')
    const id = layoutId(active)
    if (!id) throw new Error('Invalid layout id')
    this.data.layouts = list as WorkspaceLayout[]
    this.data.activeLayout = id
    await this.save()
    return this.get()
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }
}
