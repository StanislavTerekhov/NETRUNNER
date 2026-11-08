import { app, BrowserWindow, dialog, safeStorage, session, shell, utilityProcess, type IpcMainInvokeEvent } from 'electron'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import type { AgentTask, EventChannel, EventChannels, NetLogEntry } from '../shared/ipc'
import { registerIpc, windowState } from './ipc'
import { ConversationStore } from './services/conversations'
import { Database, vecExtensionPath } from './services/db'
import { FirewallService } from './services/firewall'
import { MetricsStore, NetLog } from './services/metrics'
import { TelemetryService } from './services/telemetry'
import { RI_LIMITS, RiMonitor } from './services/ri-monitor'
import { Autotuner, ProfileStore } from './services/autotune'
import { MemoryService } from './services/memory'
import { formatVerifiedFacts, TaskQueue } from './services/tasks'
import { GitService } from './services/git'
import { NetProxy } from './services/net-proxy'
import { pathWithGit } from './services/git-path'
import { counterDelta, findRuntimeDir, LlamaRuntime, LMSTUDIO_PREFIX, operatorProfile, resolveRoles, type ModelRoot, type ServerCounters } from './services/llamacpp'
import { findLmStudioModelsDir } from './services/lmstudio'
import { findRipgrep } from './services/ripgrep'
import { frame, LspFramer, LspService, pathServers } from './services/lsp'
import { ForgeService, forgeHome } from './services/forge'
import { assertOnlineAllowed } from './services/endpoint-policy'
import { OpenCodeService } from './services/opencode'
import { PtyService } from './services/pty'
import { SettingsStore } from './services/settings'
import { SecretStore } from './services/secrets'
import { WEB_TOOL_DEFS, WebTools } from './services/web-tools'
import { McpToolServer } from './services/mcp-server'
import { Workspace } from './services/workspace'

/** Build flag: false in the release installer, so its self-test mode is not even in the bundle. */
declare const __NETRUNNER_SMOKE__: boolean

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dist-electron/main/index.js → app root is two levels up
process.env.APP_ROOT = path.join(__dirname, '../..')

export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

if (process.env.NETRUNNER_USER_DATA) app.setPath('userData', process.env.NETRUNNER_USER_DATA)
if (process.platform === 'win32') app.setAppUserModelId('NETRUNNER')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const preload = path.join(__dirname, '../preload/index.cjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')
const indexUrl = pathToFileURL(indexHtml).href

let win: BrowserWindow | null = null
// Deleting from the explorer moves to the recycle bin; disk changes (agents, git, other tools) reach the UI.
const workspace = new Workspace(
  p => shell.trashItem(p),
  paths => send('fs:changed', paths),
)
const settings = new SettingsStore(app.getPath('userData'), () => (/^ru\b/i.test(app.getPreferredSystemLanguages()[0] ?? app.getLocale()) ? 'ru' : 'en'))
const database = new Database(
  path.join(app.getPath('userData'), 'netrunner.db'),
  vecExtensionPath(process.env.APP_ROOT, app.isPackaged ? process.resourcesPath : null),
)
const conversations = new ConversationStore(database)
const send = <C extends EventChannel>(channel: C, payload: EventChannels[C]) => win?.webContents.send(channel, payload)
// Every proxied request (and every blocked renderer request) lands in the persistent network log.
const netLog = new NetLog(database, entry => send('network:entry', entry))
// Local inference: llama.cpp runtime and GGUF models live outside AppData (multi-GB, shared with FORGE).
// Git installed together with NETRUNNER may not be on the inherited PATH yet (agents need it).
if (process.platform === 'win32') {
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'Path'
  process.env[key] = pathWithGit(process.env[key] ?? '')
}
const netrunnerHome = process.env.NETRUNNER_HOME ?? path.join(app.getPath('home'), 'NETRUNNER')
const runtimeRoot = path.join(netrunnerHome, 'runtime', 'llama.cpp')
const ripgrepDir = path.join(netrunnerHome, 'runtime', 'ripgrep')
// LM Studio's downloads are read in place and run with NETRUNNER's own llama.cpp (LM Studio is not started).
const lmStudioRoots = (): ModelRoot[] => {
  const dir = findLmStudioModelsDir(app.getPath('home'), settings.get().lmStudioDir)
  return dir ? [{ source: 'lmstudio', dir, prefix: LMSTUDIO_PREFIX }] : []
}
const llama = new LlamaRuntime({
  // NETRUNNER_RUNTIME_DIR (measurements only): another llama.cpp build, e.g. NETRUNNER's own (NSC stage 5).
  binaryDir: () => process.env.NETRUNNER_RUNTIME_DIR || findRuntimeDir(runtimeRoot),
  modelsDir: path.join(netrunnerHome, 'models'),
  extraRoots: lmStudioRoots,
  getMode: () => settings.get().networkMode,
  onDownload: (host, detail) =>
    void netLog.record({ time: new Date().toISOString(), source: 'model-download', method: 'GET', host, port: 443, allowed: true, reason: `${detail} (ONLINE TOOLS)` }),
  // The tuned profile, plus fast mode (fewer MoE experts per token) when the operator turned it on.
  // VRAM saver (NSC-ME phase 6) replaces the expert cache: all experts stay in RAM.
  getProfile: id => operatorProfile(profiles.active(id), settings.get().fastExperts[id], settings.get().vramSaver.includes(id)),
  // Conversations saved before an idle unload and restored at the next load (NSC-ME phase 4).
  slotsDir: path.join(netrunnerHome, 'slots'),
})
// NSC-ME phase 3: unload models nobody used for a while (settings), and any idle model when RAM runs out.
const idleTimer = setInterval(() => {
  const ramPressure = os.freemem() < RI_LIMITS.ramLowGiB * 2 ** 30
  void llama
    .idleSweep(settings.get().idleUnload, ramPressure)
    .then(list => list.forEach(u => console.log(`[models] unloaded idle ${u.modelId} after ${u.idleMin} min${ramPressure ? ' (low RAM)' : ''}; saved conversations: ${u.savedSlots}`)))
    .catch(() => undefined)
}, 60_000)
const roles = async () => resolveRoles(await llama.catalog.list(), settings.get())
const memory = new MemoryService(
  database,
  (model, inputs) => llama.embed(model, inputs),
  async () => {
    const id = (await roles()).embedding
    if (!id) throw new Error('No embedding model installed (MODEL VAULT → SETUP)')
    return id
  },
  // In 'rerank' mode (MEMORY) the best candidates are re-scored by the reranker model, when one is installed.
  async (query, documents) => {
    const id = (await roles()).reranker
    return id ? llama.rerank(id, query, documents) : null
  },
)
const logEntry = ({ id: _id, ...entry }: NetLogEntry) => void netLog.record(entry)
// One policy proxy per source so the network log says who made each request.
const netRules = () => settings.get().netRules
const proxy = new NetProxy(() => settings.get().networkMode, logEntry, netRules)
const terminalProxy = new NetProxy(() => settings.get().networkMode, logEntry, netRules)
// NSC stage 2: reverse interference — what else on the PC slows the models down (docs/NSC-STAGE2.md).
const ri = new RiMonitor({ footprint: () => llama.footprint(), emit: s => send('ri:state', s) })
const metrics = new MetricsStore(database, (model, tps, earlier) => {
  ri.onRun(model, tps, earlier)
  autotuner.onRun(model)
})
// NSC stage 3: launch settings per model, found by measurement and reverted when real runs get slower.
const profiles = new ProfileStore(database)
const autotuner = new Autotuner({
  runtime: llama,
  profiles,
  emit: e => send('autotune:event', e),
  speedsAround: (model, at) => metrics.speedsAround(model, at),
  interference: () => ri.get().findings.some(f => f.severity !== 'info' && f.kind !== 'speed-drop'),
})

// ----- Web tools (chat and agents): search, pages, repositories; ONLINE TOOLS only -----
const secrets = new SecretStore(app.getPath('userData'), {
  encrypt: s => safeStorage.encryptString(s),
  decrypt: b => safeStorage.decryptString(b),
  available: () => safeStorage.isEncryptionAvailable(),
})
const webProxy = new NetProxy(() => settings.get().networkMode, logEntry, netRules)
const webTools = new WebTools({
  networkMode: () => settings.get().networkMode,
  permission: () => settings.get().webTools,
  provider: () => settings.get().webSearch.provider,
  searxngUrl: () => settings.get().webSearch.searxngUrl,
  secrets: () => ({ braveKey: secrets.get('brave'), googleKey: secrets.get('google'), googleCx: secrets.get('google-cx') }),
  confirm: async (message, detail) => {
    const ru = settings.get().language === 'ru'
    const box = { type: 'question' as const, buttons: [ru ? 'Разрешить' : 'Allow', ru ? 'Отклонить' : 'Deny'], defaultId: 1, cancelId: 1, title: 'NETRUNNER — WEB', message, detail }
    const { response } = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
    return response === 0
  },
  log: (host, method, allowed, reason) => void netLog.record({ time: new Date().toISOString(), source: 'web-tools', method, host, port: 443, allowed, reason }),
  reposDir: path.join(netrunnerHome, 'repos'),
  rules: netRules,
  childEnv: async () => {
    await webProxy.start('web-tools')
    return webProxy.childEnv()
  },
})
const mcpTools = new McpToolServer({ defs: WEB_TOOL_DEFS, run: (name, args, signal) => webTools.run(name, args, signal) })
const telemetry = new TelemetryService(
  sample => send('telemetry:sample', sample),
  () => app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0),
)
const startProxy = async () => {
  await proxy.start('agent')
  return proxy.childEnv()
}
const pty = new PtyService(
  (id, data) => send('pty:data', { id, data }),
  (id, code) => send('pty:exit', { id, code }),
  () => (terminalProxy.url ? terminalProxy.childEnv() : {}),
)
const git = new GitService(() => workspace.current?.root ?? null)
// Editor language servers: bundled pyright for Python (in an Electron utility process, bridged over its message
// port), plus rust-analyzer / gopls / clangd when installed on PATH.
const pyrightScript = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pyright', 'langserver.index.js')
  : path.join(process.env.APP_ROOT, 'node_modules', 'pyright', 'langserver.index.js')
const pyrightHost = app.isPackaged ? path.join(process.resourcesPath, 'lsp', 'pyright-host.cjs') : path.join(process.env.APP_ROOT, 'electron', 'lsp-host', 'pyright-host.cjs')
const lsp = new LspService(
  [
    {
      id: 'python',
      label: 'pyright',
      languages: ['python'],
      launch: root => {
        if (!existsSync(pyrightScript) || !existsSync(pyrightHost)) return null
        const child = utilityProcess.fork(pyrightHost, [pyrightScript], { cwd: root, serviceName: 'NETRUNNER pyright', stdio: 'pipe' })
        // The tail of stderr explains a crash in the status (and the log).
        let stderr = ''
        child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
        // The host speaks LSP as JSON objects (node-ipc); LspService speaks framed bytes: convert at the edge.
        const outgoing = new LspFramer()
        return Promise.resolve({
          write: d => outgoing.push(d, msg => child.postMessage(msg)),
          onData: cb => void child.on('message', (m: unknown) => cb(frame(m))),
          onExit: cb => void child.once('exit', code => cb(`code ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''}`)),
          kill: () => void child.kill(),
        })
      },
    },
    ...pathServers(),
  ],
  () => workspace.current?.root ?? null,
  (p, diagnostics) => send('lsp:diagnostics', { path: p, diagnostics }),
)
const opencodeBinary = app.isPackaged
  ? path.join(process.resourcesPath, 'opencode', 'opencode.exe')
  : path.join(process.env.APP_ROOT, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe')
// FIREWALL lists NETRUNNER's own programs; the operator adds others and decides which are blocked.
const firewall = new FirewallService({
  builtin: () => {
    const llamaDir = findRuntimeDir(runtimeRoot)
    const rg = findRipgrep(ripgrepDir)
    return [
      { path: opencodeBinary, label: 'OpenCode (agent engine)' },
      ...(llamaDir ? [{ path: path.join(llamaDir, 'llama-server.exe'), label: 'llama-server (local models)' }] : []),
      ...(rg ? [{ path: rg, label: 'ripgrep (agent search)' }] : []),
    ]
  },
  wanted: () => settings.get().firewall,
})
const agent = new OpenCodeService({
  binary: opencodeBinary,
  // Always registered: each web tool checks the network mode when it is called (ONLINE TOOLS only).
  webTools: () => mcpTools.start(),
  dataDir: path.join(app.getPath('userData'), 'opencode'),
  acquireModel: async (model, lanes) => {
    llama.pinned = null
    // One llama-server slot (65K context each) per agent job that may run at the same time, plus one for NEURAL CORE:
    // while the engine runs, chat is answered by this model instead of reloading the chat model.
    const s = await llama.ensure('chat', model, 65536, lanes + 1)
    llama.pinned = model
    // Read the weights into the OS cache now, so the first task does not page experts in from disk.
    const warm = await llama.prewarm(model)
    console.log(`[agent] prewarmed ${(warm.bytes / 2 ** 30).toFixed(1)} GiB in ${(warm.ms / 1000).toFixed(0)} s`)
    const entry = await llama.catalog.get(model)
    return { baseURL: s.url, apiKey: s.key, label: entry.name, contextLength: s.ctx }
  },
  releaseModel: () => {
    llama.pinned = null
  },
  getMode: () => settings.get().networkMode,
  proxyEnv: startProxy,
  ripgrepDir: () => {
    const rg = findRipgrep(ripgrepDir)
    return rg ? path.dirname(rg) : null
  },
  emit: event => {
    send('agent:event', event)
    tasks.onAgentEvent(event)
  },
})
const tasks = new TaskQueue({
  store: database,
  agent,
  workspace: () => workspace.current?.root ?? null,
  checkpoint: async label => ((await git.isRepo()) ? (await git.checkpoint(label)).commit : null),
  searchMemory: query => {
    const ws = workspace.current?.root
    return ws ? memory.search(ws, query, 8, settings.get().memorySearch) : Promise.resolve([])
  },
  onChange: list => {
    send('tasks:changed', list)
    void measureAgentTasks(list)
  },
  // Ground truth between pipeline steps: the real diff since the pipeline started and the tool log of each step.
  verifiedFacts: async (t, previous) => {
    const base = t.worktree?.base ?? previous.find(p => p.pipelineStep === 0)?.checkpoint ?? null
    const diff = base ? await git.diffText(base, t.worktree?.path).catch(() => '') : ''
    const steps = []
    for (const p of previous) if (p.sessionId) steps.push({ task: p, parts: await agent.history(p.sessionId).catch(() => []) })
    return formatVerifiedFacts(diff, steps)
  },
  // Lanes are fixed when the engine starts (the model server's slot count).
  lanes: () => agent.state.lanes,
  worktrees: {
    available: () => git.isRepo(),
    create: async (jobId, label) => {
      const root = workspace.current?.root
      if (!root) throw new Error('No workspace is open')
      const base = (await git.checkpoint(label)).commit
      const key = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10)
      const dir = path.join(netrunnerHome, 'worktrees', key, jobId)
      // A leftover folder from an earlier database (same job id) must not block the new checkout.
      if (await fs.stat(dir).catch(() => null)) await git.removeWorktree(dir)
      await git.addWorktree(dir, base)
      return { path: dir, base }
    },
    changes: (base, dir) => git.worktreeChanges(base, dir),
    merge: async (base, dir, label) => {
      const checkpoint = (await git.checkpoint(label)).commit
      return { checkpoint, ...(await git.mergeWorktree(base, dir)) }
    },
    remove: dir => git.removeWorktree(dir),
  },
})

// FORGE from the UI: scripts ship next to the app (resources/forge when packaged); the Python environment lives in
// %USERPROFILE%\NETRUNNER\forge and is installed on request (ONLINE TOOLS).
const forge = new ForgeService({
  home: forgeHome(),
  scriptsDir: app.isPackaged ? path.join(process.resourcesPath, 'forge') : path.join(process.env.APP_ROOT, 'forge'),
  prepare: async () => {
    if (agent.state.status === 'running' || agent.state.status === 'starting') throw new Error('Stop the agent engine first: FORGE needs the GPU and RAM')
    // Teacher/judge models and training need the memory the app's model servers hold.
    await llama.stopAll()
  },
  assertOnline: () => assertOnlineAllowed(settings.get().networkMode, 'FORGE setup download'),
  proxyEnv: async () => {
    await proxy.start('agent')
    return proxy.childEnv()
  },
  emit: (job, line) => send('forge:event', { job, line }),
})

// Agent speed: OpenCode reports no timings, so llama-server's token counters are read when a task starts and ends.
const taskCounters = new Map<number, ServerCounters & { modelId: string; startedAt: number }>()
async function measureAgentTasks(list: AgentTask[]): Promise<void> {
  for (const t of list) {
    if (t.status === 'running' && !taskCounters.has(t.id)) {
      const c = await llama.counters('chat')
      if (c) taskCounters.set(t.id, { ...c, startedAt: Date.now() })
    } else if (t.status !== 'running' && t.status !== 'queued' && taskCounters.has(t.id)) {
      const start = taskCounters.get(t.id)!
      taskCounters.delete(t.id)
      const end = await llama.counters('chat')
      if (end && end.modelId === start.modelId) metrics.recordAgent(start.modelId, t.id, { ...counterDelta(start, end), totalMs: Date.now() - start.startedAt })
    }
  }
}

function isAppUrl(url: string): boolean {
  if (VITE_DEV_SERVER_URL) return url.startsWith(VITE_DEV_SERVER_URL)
  return url.split('#')[0] === indexUrl
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return !!frame && !!win && event.sender === win.webContents && frame === win.webContents.mainFrame && isAppUrl(frame.url)
}

/** Renderer may only reach its own bundle (and the Vite dev server in development). */
function isAllowedRendererRequest(url: string): boolean {
  if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('devtools:')) {
    return url.startsWith('file:') ? url.startsWith(pathToFileURL(RENDERER_DIST).href) : true
  }
  if (VITE_DEV_SERVER_URL) {
    const dev = new URL(VITE_DEV_SERVER_URL)
    try {
      const u = new URL(url)
      return u.hostname === dev.hostname && u.port === dev.port
    } catch {
      return false
    }
  }
  return false
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRendererRequest(details.url)
    if (!allowed) {
      let host = details.url
      let port = 0
      try {
        const u = new URL(details.url)
        host = u.hostname
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
      } catch {
        /* keep raw url */
      }
      netLog.record({ time: new Date().toISOString(), source: 'renderer', method: details.method, host, port, allowed: false, reason: 'renderer may only load its own bundle' })
    }
    callback({ cancel: !allowed })
  })
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    title: 'NETRUNNER',
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#07090B',
    icon: path.join(process.env.VITE_PUBLIC!, 'favicon.ico'),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Smoke runs capture screenshots while the window may be covered; keep it painting.
      backgroundThrottling: !process.env.NETRUNNER_SMOKE_OUT,
    },
  })

  const sendState = () => win && win.webContents.send('window:state', windowState(win))
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur'] as const) win.on(ev as 'maximize', sendState)

  win.once('ready-to-show', () => win?.show())

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links open in the system browser only after the user clicked them, and only https.
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) await win.loadURL(VITE_DEV_SERVER_URL)
  else await win.loadFile(indexHtml)

  const smokeOut = process.env.NETRUNNER_SMOKE_OUT
  if (__NETRUNNER_SMOKE__ && smokeOut) void import('./smoke').then(m => m.runSmokeTest(win!, smokeOut))
}

app.whenReady().then(async () => {
  await settings.load()
  await secrets.load()
  // Phase 2 stored chats as JSON files; move them into SQLite once.
  const imported = await conversations.importJsonDir(path.join(app.getPath('userData'), 'conversations'))
  if (imported) console.log(`[db] imported ${imported} conversation(s) from JSON`)
  const last = settings.get().lastWorkspace
  if (last) await workspace.open(last).catch(() => undefined)
  hardenSession()
  // Terminal shells also go through the policy proxy, so it runs from startup.
  await terminalProxy.start('terminal')
  registerIpc({
    getWindow: () => win,
    isTrustedSender,
    workspace,
    settings,
    llama,
    roles,
    runtimeRoot,
    lmStudioRoots,
    ripgrepDir,
    lsp,
    forge,
    conversations,
    proxies: [proxy, terminalProxy],
    pty,
    git,
    agent,
    memory,
    tasks,
    metrics,
    netLog,
    telemetry,
    ri,
    autotuner,
    profiles,
    firewall,
    webTools,
    secrets,
  })
  await createWindow()
  ri.start()
})

app.on('before-quit', () => {
  telemetry.stop()
  ri.stop()
  clearInterval(idleTimer)
  workspace.close()
  void lsp.stopAll()
  void forge.cancel()
  pty.killAll(true)
  void agent.stop()
  // llama-server processes hold tens of GB of RAM/VRAM; never leave them behind.
  void llama.stopAll()
  void proxy.stop()
  void webProxy.stop()
  void mcpTools.stop()
  void terminalProxy.stop()
  database.close()
})

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

app.on('window-all-closed', () => {
  win = null
  app.quit()
})

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})
