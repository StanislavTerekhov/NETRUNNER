import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  INVOKE_CHANNELS,
  type EventChannel,
  type EventChannels,
  type InvokeChannel,
  type InvokeChannels,
  type WindowState,
} from '../shared/ipc'
import type { ConversationStore } from './services/conversations'
import { checkRequests, undoChatFiles, writeChatFiles, type ChatFileDeps } from './services/chat-files'
import { listForgeRuns, type ForgeService } from './services/forge'
import type { GitService } from './services/git'
import type { FirewallService } from './services/firewall'
import type { MemoryService } from './services/memory'
import type { MetricsStore, NetLog } from './services/metrics'
import { checkSetup } from './services/setup'
import { traffic } from './services/traffic'
import type { TelemetryService } from './services/telemetry'
import type { RiMonitor } from './services/ri-monitor'
import type { Autotuner, ProfileStore } from './services/autotune'
import type { TaskQueue } from './services/tasks'
import { readHardware } from './services/hardware'
import type { NetProxy } from './services/net-proxy'
import type { OpenCodeService } from './services/opencode'
import type { PtyService } from './services/pty'
import { counterDelta, type LlamaRuntime, type ModelRoot, type resolveRoles } from './services/llamacpp'
import { checkRuntimeUpdate, installRuntime } from './services/runtime-install'
import { findRipgrep, installRipgrep } from './services/ripgrep'
import type { LspService } from './services/lsp'
import type { SettingsStore } from './services/settings'
import type { Workspace } from './services/workspace'
import { WEB_TOOL_DEFS, type WebTools } from './services/web-tools'
import type { SecretStore } from './services/secrets'

type Handler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeChannels[C]['args']
) => Promise<InvokeChannels[C]['result']> | InvokeChannels[C]['result']

interface Deps {
  getWindow: () => BrowserWindow | null
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  workspace: Workspace
  settings: SettingsStore
  llama: LlamaRuntime
  roles: () => Promise<ReturnType<typeof resolveRoles>>
  runtimeRoot: string
  lmStudioRoots: () => ModelRoot[]
  ripgrepDir: string
  lsp: LspService
  forge: ForgeService
  conversations: ConversationStore
  proxies: NetProxy[]
  pty: PtyService
  git: GitService
  agent: OpenCodeService
  memory: MemoryService
  tasks: TaskQueue
  metrics: MetricsStore
  netLog: NetLog
  telemetry: TelemetryService
  ri: RiMonitor
  autotuner: Autotuner
  profiles: ProfileStore
  firewall: FirewallService
  webTools: WebTools
  secrets: SecretStore
}

const PERMISSION_RESPONSES = new Set(['once', 'always', 'reject'])

export function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), focused: win.isFocused() }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`Invalid ${name}`)
  return value
}

export function registerIpc({ getWindow, isTrustedSender, workspace, settings, llama, roles, runtimeRoot, lmStudioRoots, ripgrepDir, lsp, forge, conversations, pty, git, agent, memory, tasks, metrics, netLog, telemetry, ri, autotuner, profiles, firewall, webTools, secrets }: Deps): void {
  const workspaceRoot = () => {
    const ws = workspace.current
    if (!ws) throw new Error('Open a workspace first')
    return ws.root
  }
  const emit = <C extends EventChannel>(channel: C, payload: EventChannels[C]) => getWindow()?.webContents.send(channel, payload)
  const cspWindow = { start: 0, count: 0 }
  let liveCounters: Awaited<ReturnType<LlamaRuntime['counters']>> = null
  /** Native dialogs follow the interface language. */
  const L = (en: string, ru: string) => (settings.get().language === 'ru' ? ru : en)
  const confirm = async (opts: { title: string; message: string; detail: string; ok: string }) => {
    const win = getWindow()
    const box = { type: 'warning' as const, buttons: [opts.ok, L('Cancel', 'Отмена')], defaultId: 1, cancelId: 1, title: opts.title, message: opts.message, detail: opts.detail }
    const { response } = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
    return response === 0
  }
  // Chat code blocks written as files: the mode from settings is applied here, confirmations are main-process dialogs.
  const chatFiles: ChatFileDeps = {
    read: async p => {
      try {
        return (await workspace.read(p)).content
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
    },
    put: (p, content) => workspace.put(p, content),
    remove: p => workspace.remove(p),
    confirm: (lines, partial) =>
      confirm({
        title: 'NETRUNNER',
        message: L('Write these files from the chat answer?', 'Записать эти файлы из ответа чата?'),
        detail:
          `${lines.join('\n')}\n\n` +
          (partial
            ? L('Warning: a block looks like an excerpt ("... existing code"); the file would be replaced by it.\n', 'Внимание: блок похож на фрагмент («... existing code»), файл будет заменён им.\n')
            : '') +
          L('+ new file, ~ overwrite (lines before → after). UNDO under the answer restores the previous content.', '+ новый файл, ~ перезапись (строк было → станет). ОТМЕНИТЬ под ответом вернёт прежнее содержимое.'),
        ok: L('Write', 'Записать'),
      }),
  }
  // The agent engine is bound to one folder: when another workspace opens, restart it there with the same model.
  const followWorkspace = (root: string) => {
    // Language servers index one folder; they restart lazily for the new one.
    void lsp.stopAll()
    const st = agent.state
    if ((st.status !== 'running' && st.status !== 'starting') || !st.model || st.workspace === root) return
    const model = st.model
    void (async () => {
      await agent.stop()
      await agent.start(root, model, settings.get().agentLanes).catch(() => undefined)
    })()
  }
  /** A Python 3.13 interpreter for FORGE setup: the py launcher first, then python on PATH. */
  const systemPython = async (): Promise<string | null> => {
    const probe = (cmd: string, args: string[]) =>
      new Promise<string | null>(resolve =>
        execFile(cmd, [...args, '-c', 'import sys; print(sys.executable) if sys.version_info[:2] == (3, 13) else None'], { timeout: 8000, windowsHide: true }, (err, out) =>
          resolve(err ? null : out.trim().split(/\r?\n/)[0] || null),
        ),
      )
    return (await probe('py', ['-3.13'])) ?? (await probe('python', []))
  }
  const requireJob = (id: unknown) => {
    if (typeof id !== 'string' || !/^j\d{1,12}$/.test(id)) throw new Error('Invalid job id')
    return id
  }

  const handlers: { [C in InvokeChannel]: Handler<C> } = {
    'window:minimize': () => getWindow()?.minimize(),
    'window:toggle-maximize': () => {
      const win = getWindow()
      if (!win) return { maximized: false, focused: false }
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return windowState(win)
    },
    'window:close': () => getWindow()?.close(),
    'window:get-state': () => {
      const win = getWindow()
      return win ? windowState(win) : { maximized: false, focused: false }
    },
    'app:info': () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      userData: app.getPath('userData'),
    }),
    'settings:get': () => settings.get(),
    'settings:set-network-mode': (_e, mode) => settings.setNetworkMode(mode),
    'settings:set-default-model': (_e, model) => settings.setDefaultModel(model === null ? null : requireString(model, 'model')),
    'settings:set-agent-model': (_e, model) => settings.setAgentModel(model === null ? null : requireString(model, 'model')),
    'settings:set-embedding-model': (_e, model) => settings.setEmbeddingModel(model === null ? null : requireString(model, 'model')),
    'workspace:pick': async () => {
      const win = getWindow()
      const opts = { title: L('Open workspace', 'Открыть проект'), properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) return null
      const info = await workspace.open(result.filePaths[0])
      await settings.rememberWorkspace(info.root)
      followWorkspace(info.root)
      return info
    },
    'workspace:open': async (_e, root) => {
      // Only roots the user already chose through the folder dialog may be reopened by path.
      if (!settings.get().recentWorkspaces.includes(root)) {
        throw new Error('Workspace is not in the recent list; open it with the folder picker')
      }
      const info = await workspace.open(root)
      await settings.rememberWorkspace(info.root)
      followWorkspace(info.root)
      return info
    },
    'workspace:current': () => workspace.current,
    'fs:list': (_e, relPath) => workspace.list(relPath),
    'fs:read': (_e, relPath) => workspace.read(relPath),
    'fs:write': (_e, relPath, content, expectedMtimeMs) => workspace.write(relPath, content, expectedMtimeMs),
    'fs:create': (_e, relPath, kind) => workspace.create(requireString(relPath, 'path'), kind === 'dir' ? 'dir' : 'file'),
    'fs:rename': (_e, from, to) => workspace.rename(requireString(from, 'path'), requireString(to, 'path')),
    'fs:delete': async (_e, relPath) => {
      const p = requireString(relPath, 'path')
      const ok = await confirm({
        title: L('Delete', 'Удаление'),
        message: L(`Move "${p}" to the Recycle Bin?`, `Переместить «${p}» в корзину?`),
        detail: L('It can be restored from the Recycle Bin.', 'Его можно восстановить из корзины.'),
        ok: L('Move to Recycle Bin', 'В корзину'),
      })
      if (!ok) throw new Error('Delete cancelled')
      await workspace.remove(p)
    },
    'runtime:status': () => llama.status(),
    'models:list': () => llama.list(),
    'models:details': (_e, name) => llama.details(requireString(name, 'model')),
    'models:fit': (_e, name) => llama.fitPlan(requireString(name, 'model')),
    'models:running': () => llama.running(),
    'models:load': (_e, name) => llama.load(requireString(name, 'model')),
    'models:unload': (_e, name) => llama.unload(requireString(name, 'model')),
    'models:delete': async (_e, name) => {
      const model = requireString(name, 'model')
      const win = getWindow()
      // Destructive: confirmed in a native dialog owned by the main process, not only in the renderer.
      const opts = {
        type: 'warning' as const,
        buttons: [L('Delete', 'Удалить'), L('Cancel', 'Отмена')],
        defaultId: 1,
        cancelId: 1,
        title: L('Delete model', 'Удаление модели'),
        message: L(`Delete local model "${model}"?`, `Удалить локальную модель «${model}»?`),
        detail: L('The weights are removed from disk. Downloading them again needs ONLINE TOOLS mode.', 'Веса удаляются с диска. Чтобы скачать их снова, нужен режим ОНЛАЙН-ИНСТРУМЕНТЫ.'),
      }
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) throw new Error('Deletion cancelled')
      await llama.remove(model)
    },
    // Hugging Face download ("owner/repo:QUANT"); each request is recorded in the network log by the runtime.
    'models:pull': (_e, name) => llama.startPull(requireString(name, 'model'), p => emit('models:pull-progress', p)),
    'models:pull-cancel': (_e, id) => llama.stopStream(requireString(id, 'pull id')),
    'hardware:info': () => readHardware(),
    'chat:start': (_e, req) => {
      requireString(req?.model, 'model')
      if (!Array.isArray(req.messages) || req.messages.length === 0) throw new Error('Chat needs at least one message')
      for (const m of req.messages) {
        if (m.images === undefined) continue
        if (!Array.isArray(m.images) || m.images.length > 4) throw new Error('At most 4 images per message')
        for (const img of m.images) {
          if (typeof img !== 'string' || img.length > 8_000_000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(img)) throw new Error('Images must be PNG/JPEG/WebP/GIF data URLs under 6 MB')
        }
      }
      // WEB on: the model may call the web tools while it answers (each call is shown in the chat).
      const tools = req.web === true ? { defs: WEB_TOOL_DEFS, run: (name: string, args: Record<string, unknown>, signal: AbortSignal) => webTools.run(name, args, signal) } : undefined
      return llama.startChat(
        req,
        chunk => {
          if (chunk.done && chunk.metrics && !chunk.error) metrics.recordChat(chunk.servedModel ?? req.model, chunk.metrics)
          emit('chat:chunk', chunk)
        },
        tools,
      )
    },
    'chat:stop': (_e, id) => llama.stopStream(requireString(id, 'stream id')),
    'conversations:list': () => conversations.list(),
    'conversations:get': (_e, id) => conversations.get(id),
    'conversations:save': (_e, c) => conversations.save(c),
    'conversations:delete': (_e, id) => conversations.remove(id),
    'lsp:open': (_e, p, languageId, text) => {
      if (typeof text !== 'string' || text.length > 5_000_000) throw new Error('Invalid document')
      return lsp.open(requireString(p, 'path'), requireString(languageId, 'language'), text)
    },
    'lsp:change': (_e, p, text) => {
      if (typeof text !== 'string' || text.length > 5_000_000) throw new Error('Invalid document')
      return lsp.change(requireString(p, 'path'), text)
    },
    'lsp:close': (_e, p) => lsp.close(requireString(p, 'path')),
    'lsp:saved': (_e, p) => lsp.saved(requireString(p, 'path')),
    'lsp:request': (_e, p, feature, position) => {
      if (!['completion', 'hover', 'definition', 'signatureHelp'].includes(feature)) throw new Error('Unsupported LSP feature')
      const line = Number(position?.line)
      const character = Number(position?.character)
      if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) throw new Error('Invalid position')
      return lsp.request(requireString(p, 'path'), feature, { line, character })
    },
    'lsp:status': () => lsp.status(),
    'forge:env': async () => forge.env(await systemPython()),
    'forge:start': async (_e, req) => forge.start({ ...req, workspace: workspace.current?.root ?? '' }, req?.steps?.includes('setup') ? await systemPython() : null),
    'forge:cancel': () => forge.cancel(),
    'forge:state': () => forge.state,
    'conversations:search': (_e, query) => {
      if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid query')
      return conversations.search(query)
    },
    'conversations:export': async (_e, id, format) => {
      const fmt = format === 'json' ? 'json' : 'md'
      const text = conversations.export(requireString(id, 'conversation id'), fmt)
      const title = conversations.get(id).title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'chat'
      const win = getWindow()
      const opts = { title: L('Export chat', 'Экспорт чата'), defaultPath: `${title}.${fmt}`, filters: [fmt === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: 'JSON', extensions: ['json'] }] }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, text, 'utf8')
      return res.filePath
    },
    'forge:runs': () => listForgeRuns(),
    'network:log': () => netLog.list(1000),
    'network:traffic': () => traffic.list(),
    'network:clear': () => netLog.clear(),
    // The page's CSP blocks external requests before they reach Electron's network layer; the renderer
    // reports each violation so the log stays complete. Only http(s)/ws(s) URLs are recorded.
    'network:csp-violation': (_e, blockedUrl, directive) => {
      // A page that fires violations in a loop must not flood the persistent log.
      const now = Date.now()
      if (now - cspWindow.start > 1000) Object.assign(cspWindow, { start: now, count: 0 })
      if (++cspWindow.count > 20) return
      let url: URL
      try {
        url = new URL(String(blockedUrl))
      } catch {
        return
      }
      if (!/^(https?|wss?):$/.test(url.protocol)) return
      netLog.record({
        time: new Date().toISOString(),
        source: 'renderer-csp',
        method: String(directive).slice(0, 40),
        host: url.hostname.slice(0, 253),
        port: Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80),
        allowed: false,
        reason: 'blocked by Content-Security-Policy',
      })
    },
    'pty:create': () => pty.create(workspaceRoot()),
    'pty:write': (_e, id, data) => {
      if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('Invalid terminal input')
      pty.write(requireString(id, 'pty id'), data)
    },
    'pty:resize': (_e, id, cols, rows) => pty.resize(requireString(id, 'pty id'), Number(cols), Number(rows)),
    'pty:kill': (_e, id) => pty.kill(requireString(id, 'pty id')),
    'git:status': () => git.status(),
    'git:init': () => git.init(),
    'git:checkpoints': () => git.checkpoints(),
    'git:checkpoint': (_e, label) => git.checkpoint(String(label ?? '')),
    'git:changes': (_e, commit) => git.changes(requireString(commit, 'checkpoint')),
    'git:file-versions': (_e, commit, p) => git.fileVersions(requireString(commit, 'checkpoint'), requireString(p, 'path')),
    'git:restore': async (_e, commit) => {
      const c = requireString(commit, 'checkpoint')
      const win = getWindow()
      // Restoring overwrites and deletes files: confirmed in a main-process dialog.
      const opts = {
        type: 'warning' as const,
        buttons: [L('Revert files', 'Откатить файлы'), L('Cancel', 'Отмена')],
        defaultId: 1,
        cancelId: 1,
        title: L('Revert to checkpoint', 'Откат к контрольной точке'),
        message: L('Revert the workspace to this checkpoint?', 'Откатить проект к этой контрольной точке?'),
        detail: L(
          'Files created since the checkpoint are deleted and changed files are restored. Ignored files are not touched.',
          'Файлы, созданные после точки, удаляются, изменённые — восстанавливаются. Игнорируемые файлы не затрагиваются.',
        ),
      }
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) throw new Error('Revert cancelled')
      await git.restore(c)
    },
    'agent:state': () => agent.state,
    'agent:start': (_e, model) => agent.start(workspaceRoot(), requireString(model, 'model'), settings.get().agentLanes),
    'agent:stop': () => agent.stop(),
    'agent:sessions': () => agent.sessions(),
    'agent:create-session': (_e, title) => agent.createSession(String(title ?? '')),
    'agent:history': (_e, id) => agent.history(requireString(id, 'session id')),
    'agent:prompt': (_e, req) => {
      requireString(req?.sessionId, 'session id')
      if (typeof req.text !== 'string' || !req.text.trim()) throw new Error('Empty task')
      return agent.prompt(req)
    },
    'agent:abort': (_e, id) => agent.abort(requireString(id, 'session id')),
    'agent:grants': () => agent.listGrants(),
    'agent:revoke-grant': (_e, key) => agent.revokeGrant(requireString(key, 'grant')),
    'agent:respond': (_e, sessionId, permissionId, response) => {
      if (!PERMISSION_RESPONSES.has(response)) throw new Error('Invalid permission response')
      return agent.respond(requireString(sessionId, 'session id'), requireString(permissionId, 'permission id'), response)
    },
    'memory:status': () => memory.status(workspaceRoot()),
    'memory:index': () => {
      const root = workspaceRoot()
      return memory.index(root, p => emit('memory:progress', p))
    },
    'memory:clear': async () => {
      const root = workspaceRoot()
      memory.clear(root)
      return memory.status(root)
    },
    'memory:search': (_e, query, k) => {
      if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Invalid query')
      return memory.search(workspaceRoot(), query, Number(k) || 8, settings.get().memorySearch)
    },
    'tasks:list': () => tasks.list(),
    'tasks:enqueue': (_e, req) => tasks.enqueue({ role: req?.role, prompt: String(req?.prompt ?? ''), useMemory: !!req?.useMemory }),
    'tasks:pipeline': (_e, goal, useMemory) => tasks.enqueuePipeline(String(goal ?? ''), !!useMemory),
    'tasks:cancel': (_e, id) => tasks.cancel(Number(id)),
    'tasks:retry': (_e, id) => tasks.retry(Number(id)),
    'tasks:job-changes': (_e, id) => tasks.jobChanges(requireJob(id)),
    'tasks:merge-job': async (_e, id) => {
      const job = requireJob(id)
      const files = await tasks.jobChanges(job)
      // Writes into the workspace: confirmed in a main-process dialog; a checkpoint is taken first.
      const ok = await confirm({
        title: L('Merge agent job', 'Слияние задания агента'),
        message: L(`Merge ${files.length} changed file(s) from job ${job} into the workspace?`, `Слить изменённые файлы задания ${job} (${files.length}) в проект?`),
        detail: `${files.slice(0, 12).map(f => `${f.status} ${f.path}`).join('\n')}${files.length > 12 ? '\n…' : ''}\n\n${L('A checkpoint is taken first, so the merge can be reviewed and reverted in GIT.', 'Сначала создаётся контрольная точка: слияние можно проверить и откатить в GIT.')}`,
        ok: L('Merge', 'Слить'),
      })
      if (!ok) throw new Error('Merge cancelled')
      return tasks.mergeJob(job)
    },
    'tasks:discard-job': async (_e, id) => {
      const job = requireJob(id)
      const ok = await confirm({
        title: L('Discard agent job', 'Отказ от задания агента'),
        message: L(`Discard the changes of job ${job}?`, `Отбросить изменения задания ${job}?`),
        detail: L('Its worktree is deleted; the workspace is not touched.', 'Его копия (worktree) удаляется; проект не затрагивается.'),
        ok: L('Discard', 'Отбросить'),
      })
      if (!ok) throw new Error('Discard cancelled')
      return tasks.discardJob(job)
    },
    'settings:set-agent-lanes': (_e, n) => settings.setAgentLanes(Number(n)),
    'settings:set-fast-experts': (_e, model, n) => settings.setFastExperts(requireString(model, 'model'), n === null ? null : Number(n)),
    'settings:set-vram-saver': (_e, model, on) => settings.setVramSaver(requireString(model, 'model'), on === true),
    'settings:set-idle-unload': (_e, small, large) => settings.setIdleUnload(Number(small), Number(large)),
    'settings:set-language': (_e, lang) => settings.setLanguage(lang),
    'settings:set-memory-search': (_e, mode) => settings.setMemorySearch(mode),
    'settings:set-chat-file-writes': (_e, mode) => settings.setChatFileWrites(mode),
    'settings:set-web-tools': (_e, mode) => settings.setWebTools(mode),
    'settings:set-web-search': (_e, provider, url) => settings.setWebSearch(provider, url === null ? null : String(url ?? '')),
    'settings:set-web-key': async (_e, which, key, cx) => {
      if (which !== 'brave' && which !== 'google') throw new Error('Unknown key')
      const value = typeof key === 'string' && key.trim() ? key.trim() : null
      if (value && (value.length > 200 || /\s/.test(value))) throw new Error('That does not look like an API key')
      await secrets.set(which, value)
      if (which === 'google') await secrets.set('google-cx', value && typeof cx === 'string' && cx.trim() ? cx.trim().slice(0, 200) : null)
      return settings.setWebKeyFlags({ brave: secrets.has('brave'), google: secrets.has('google') && secrets.has('google-cx') })
    },
    'chat:write-files': (_e, files, trigger) => {
      workspaceRoot()
      return writeChatFiles(chatFiles, checkRequests(files), trigger === 'auto' ? 'auto' : 'manual', settings.get().chatFileWrites)
    },
    'chat:undo-files': (_e, writes) => {
      workspaceRoot()
      return undoChatFiles(chatFiles, writes)
    },
    'settings:set-layouts': (_e, layouts, active) => settings.setLayouts(layouts, active),
    'settings:set-lmstudio-dir': async (_e, mode) => {
      if (mode === 'auto') return settings.setLmStudioDir(null)
      if (mode !== 'pick') throw new Error('Invalid mode')
      const win = getWindow()
      const opts = { title: L('LM Studio models folder', 'Папка моделей LM Studio'), properties: ['openDirectory' as const] }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) return settings.get()
      return settings.setLmStudioDir(result.filePaths[0])
    },
    'models:sources': async () => {
      const all = await llama.catalog.list()
      const lm = lmStudioRoots()[0] ?? null
      return [
        { source: 'netrunner' as const, dir: llama.catalog.dir, manual: false, models: all.filter(m => m.source === 'netrunner').length },
        { source: 'lmstudio' as const, dir: lm?.dir ?? null, manual: settings.get().lmStudioDir !== null, models: all.filter(m => m.source === 'lmstudio').length },
      ]
    },
    'pty:buffer': (_e, id) => pty.buffer(requireString(id, 'pty id')),
    'setup:check': async () =>
      checkSetup({
        status: () => llama.status(),
        catalog: () => llama.catalog.list(),
        roles: await roles(),
        opencodeBinary: agent.binaryPath,
        ripgrep: findRipgrep(ripgrepDir),
      }),
    'setup:install-ripgrep': () =>
      installRipgrep(ripgrepDir, settings.get().networkMode, (host, detail) =>
        void netLog.record({ time: new Date().toISOString(), source: 'runtime-download', method: 'GET', host, port: 443, allowed: true, reason: `${detail} (ONLINE TOOLS)` }),
      ),
    'models:roles': () => roles(),
    'runtime:check-update': () =>
      checkRuntimeUpdate(runtimeRoot, settings.get().networkMode, (host, detail) =>
        void netLog.record({ time: new Date().toISOString(), source: 'runtime-download', method: 'GET', host, port: 443, allowed: true, reason: `${detail} (ONLINE TOOLS)` }),
      ),
    'setup:install-runtime': () =>
      installRuntime(
        runtimeRoot,
        settings.get().networkMode,
        (host, detail) =>
          void netLog.record({ time: new Date().toISOString(), source: 'runtime-download', method: 'GET', host, port: 443, allowed: true, reason: `${detail} (ONLINE TOOLS)` }),
        app.isPackaged ? path.join(process.resourcesPath, 'crt') : path.join(process.env.APP_ROOT ?? process.cwd(), 'build', 'crt'),
      ),
    'telemetry:subscribe': () => telemetry.subscribe(),
    'telemetry:unsubscribe': () => telemetry.unsubscribe(),
    'ri:get': () => ri.get(),
    // Tuned at the settings the model is used with: the agent model with 65K context per agent lane + chat.
    'autotune:run': async (_e, name) => {
      const model = requireString(name, 'model')
      const s = settings.get()
      const agent = (await roles()).agent === model
      return autotuner.tune(model, agent ? 65536 : 0, agent ? s.agentLanes + 1 : 1, agent ? 'agent' : 'chat')
    },
    'autotune:get': (_e, name) => profiles.get(requireString(name, 'model')),
    'autotune:list': () => profiles.all(),
    'autotune:reset': (_e, name) => autotuner.reset(requireString(name, 'model')),
    'metrics:inference': (_e, limit) => metrics.inference(Number(limit) || 200),
    'metrics:tasks': () => metrics.tasks(),
    'metrics:agent-live': async () => {
      const now = agent.state.status === 'running' ? await llama.counters('chat') : null
      const prev = liveCounters
      liveCounters = now
      if (!now || !prev || prev.modelId !== now.modelId) return { tokensPerSecond: null, outputTokens: 0 }
      const d = counterDelta(prev, now)
      return { tokensPerSecond: d.outputTokens > 0 ? d.tokensPerSecond : null, outputTokens: d.outputTokens }
    },
    'firewall:status': () => firewall.status(),
    'firewall:apply': async (_e, what) => {
      const clear = what === 'clear'
      const win = getWindow()
      const list = firewall.programs().filter(p => p.wanted && p.exists)
      // Changes OS security settings: explicit confirmation here, then Windows asks for elevation (UAC).
      const opts = {
        type: 'warning' as const,
        buttons: [clear ? L('Remove rules', 'Удалить правила') : L('Apply rules', 'Применить правила'), L('Cancel', 'Отмена')],
        defaultId: 1,
        cancelId: 1,
        title: L('Windows Firewall', 'Брандмауэр Windows'),
        message: clear
          ? L('Remove every NETRUNNER rule from Windows Firewall?', 'Удалить все правила NETRUNNER из брандмауэра Windows?')
          : L(`Block internet access for ${list.length} program(s) in Windows Firewall?`, `Запретить доступ в интернет ${list.length} программ(ам) в брандмауэре Windows?`),
        detail:
          (clear ? '' : `${list.map(p => p.path).join('\n') || L('(none: existing NETRUNNER rules are removed)', '(нет: существующие правила NETRUNNER удаляются)')}\n\n`) +
          L(
            'Only rules named "NETRUNNER - …" are changed; your other rules stay. Loopback and the local network stay reachable. Windows will ask for administrator rights.',
            'Меняются только правила с именем «NETRUNNER - …», ваши остальные правила не трогаются. Loopback и локальная сеть остаются доступны. Windows запросит права администратора.',
          ),
      }
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) throw new Error('Firewall change cancelled')
      return firewall.apply(clear ? 'clear' : 'sync')
    },
    'firewall:set-program': async (_e, program, wanted) => {
      const p = requireString(program, 'program')
      if (!firewall.programs().some(x => x.path.toLowerCase() === p.toLowerCase())) throw new Error('Not in the firewall list')
      const { blocked, custom } = settings.get().firewall
      const rest = blocked.filter(b => b.toLowerCase() !== p.toLowerCase())
      await settings.setFirewallPrograms(wanted === true ? [...rest, p] : rest, custom)
      return firewall.status()
    },
    'firewall:add-program': async () => {
      const win = getWindow()
      const opts = { title: L('Program to control', 'Программа для контроля'), properties: ['openFile' as const], filters: [{ name: 'Programs', extensions: ['exe'] }] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const { blocked, custom } = settings.get().firewall
      if (!r.canceled && r.filePaths[0]) await settings.setFirewallPrograms(blocked, [...custom, r.filePaths[0]])
      return firewall.status()
    },
    'firewall:remove-program': async (_e, program) => {
      const p = requireString(program, 'program').toLowerCase()
      const { blocked, custom } = settings.get().firewall
      await settings.setFirewallPrograms(blocked.filter(b => b.toLowerCase() !== p), custom.filter(c => c.toLowerCase() !== p))
      return firewall.status()
    },
    'settings:set-net-rules': (_e, rules) => settings.setNetRules(rules),
  }

  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel] as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error(`Rejected IPC from untrusted sender on ${channel}`)
      return handler(event, ...args)
    })
  }
}
