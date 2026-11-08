// Launches the built app (dist + dist-electron) in smoke mode against this repository as the workspace,
// then checks the report the app wrote. Exit code reflects what was actually observed.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Optional: model to exercise the real chat path, e.g. NETRUNNER_SMOKE_CHAT_MODEL=qwen3.6:35b
const chatModel = process.env.NETRUNNER_SMOKE_CHAT_MODEL ?? ''
const out = path.join(root, 'test', 'output')
const userData = path.join(out, 'user-data')

// Optional: full agent run through the UI on a copy of the failing fixture project.
const agentModel = process.env.NETRUNNER_SMOKE_AGENT_MODEL ?? ''

await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(userData, { recursive: true })

let workspace = root
// A second project for the "switch the project while agents run" check; the UI opens only recent folders.
let secondWorkspace = null
if (agentModel) {
  workspace = path.join(out, 'agent-workspace')
  await fs.cp(path.join(root, 'test', 'fixtures', 'agent-sample'), workspace, { recursive: true })
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: workspace, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
  secondWorkspace = path.join(out, 'agent-workspace-2')
  await fs.cp(path.join(root, 'test', 'fixtures', 'agent-sample'), secondWorkspace, { recursive: true })
}
// FORGE model check: memory must not index the files that hold the test questions and expected answers, or the
// search hands the model its own exam. It runs on a copy of the repository without them.
// The chat-files check writes into the workspace, so it gets the copy too.
if (!agentModel && (process.env.NETRUNNER_SMOKE_TUNED_MODEL || process.env.NETRUNNER_SMOKE_FILE_MODEL)) {
  workspace = path.join(out, 'tuned-workspace')
  const skip = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', 'output', 'smoke', 'smoke.ts', 'PHASE-10.md'])
  // By hand: fs.cp refuses to copy a folder into its own subfolder, even when the filter would skip that subfolder.
  const copy = async (from, to) => {
    await fs.mkdir(to, { recursive: true })
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      if (e.isDirectory()) await copy(path.join(from, e.name), path.join(to, e.name))
      else if (e.isFile()) await fs.copyFile(path.join(from, e.name), path.join(to, e.name))
    }
  }
  await copy(root, workspace)
}
await fs.writeFile(
  path.join(userData, 'settings.json'),
  // English UI: the checks read English labels (the Russian interface is switched to and checked separately).
  JSON.stringify({ recentWorkspaces: [workspace, ...(secondWorkspace ? [secondWorkspace] : [])], lastWorkspace: workspace, language: 'en' }),
)

// NETRUNNER_SMOKE_EXE=path\to\NETRUNNER.exe runs the same checks against a packaged build.
const exe = process.env.NETRUNNER_SMOKE_EXE

async function launch(extraEnv, timeoutMs) {
  const child = spawn(exe ?? electronPath, exe ? [] : [root], {
    env: {
      ...process.env,
      NETRUNNER_SMOKE_OUT: out,
      NETRUNNER_SMOKE_FILE: 'package.json',
      NETRUNNER_USER_DATA: userData,
      VITE_DEV_SERVER_URL: '',
      ...extraEnv,
    },
    stdio: 'inherit',
  })
  const timer = setTimeout(() => {
    console.error(`smoke: timed out after ${timeoutMs / 1000}s`)
    child.kill()
  }, timeoutMs)
  const exitCode = await new Promise(resolve => child.on('exit', (code, signal) => resolve(code ?? signal)))
  clearTimeout(timer)
  if (exitCode !== 0) console.error(`smoke: app exit code ${exitCode}`)
  return exitCode
}

const code = await launch({}, process.env.NETRUNNER_SMOKE_FORGE ? 120 * 60_000 : agentModel ? 45 * 60_000 : process.env.NETRUNNER_SMOKE_TUNED_MODEL || process.env.NETRUNNER_SMOKE_FILE_MODEL || process.env.NETRUNNER_SMOKE_WEB_MODEL ? 30 * 60_000 : chatModel ? 15 * 60_000 : 5 * 60_000)
// Second launch with the same user data: queue, memory index and chat history must survive.
const restart = true
  ? await launch({ NETRUNNER_SMOKE_PERSIST_ONLY: '1', NETRUNNER_SMOKE_AGENT_MODEL: '', NETRUNNER_SMOKE_CHAT_MODEL: '' }, 90_000).then(async c => ({
      code: c,
      report: JSON.parse(await fs.readFile(path.join(out, 'smoke-report-restart.json'), 'utf8').catch(() => '{}')),
    }))
  : null

const report = JSON.parse(await fs.readFile(path.join(out, 'smoke-report.json'), 'utf8').catch(() => '{}'))
console.log(JSON.stringify(report, null, 2))
// The repository copy would otherwise be picked up by typecheck and vitest.
if (workspace.endsWith('tuned-workspace')) await fs.rm(workspace, { recursive: true, force: true })

// NETRUNNER_SMOKE_CI=1: a machine without models, runtime or GPU (CI). The checks that need them become checks that
// the app says what is missing instead.
const ci = process.env.NETRUNNER_SMOKE_CI === '1'
const checks = {
  'app exited cleanly': code === 0,
  'shell rendered': report.shellRendered === true,
  'renderer exposes only window.netrunner (no process/require)':
    report.rendererIsolation?.hasApi === true && report.rendererIsolation?.hasProcess === false && report.rendererIsolation?.hasRequire === false,
  'workspace restored from settings': report.workspace?.root === workspace,
  'explorer lists package.json': report.explorerHasFile === true,
  // llama-fit-params placement on every model card (a missing plan means the card fell back to no estimate).
  'monaco mounted': report.editorMounted === true,
  'file content shown in editor': report.editorFirstLine === '{',
  'syntax highlighting active': report.tokenized === true,
  'command palette opens via Ctrl+Shift+P': report.paletteOpened === true,
  'model download refused in STRICT OFFLINE': /ONLINE TOOLS/.test(report.pullBlockedOffline ?? ''),
  'terminal: PowerShell prompt via node-pty': report.terminalReady === true,
  'terminal: typed command executed (PTY_42)': report.terminalCommand === true,
  'terminal tabs: second shell runs its own command (TAB_48)': report.terminalTab2 === true && report.terminalTab2Command === true,
  'terminal tabs: first shell kept its own output': report.terminalTab1Kept === true,
  'explorer: new file created through the UI and opened': report.explorerCreated === true,
  'disk watcher: outside write shown in the open tab': report.diskChangeShown === true,
  'pyright (utility process): type error underlined in the editor': report.lspDiagnostics === true,
  'pyright: hover shows the signature': /def greet\(\s*name: str\s*\) -> str/.test(String(report.lspHover ?? '').replace(/\s+/g, ' ')),
  'disk watcher: deletion removed the file from the explorer': report.explorerSawDelete === true,
  'FORGE screen: environment checklist shown': !!report.forgeEnv && Object.keys(report.forgeEnv).length >= 7,
  'interface switches to Russian and back': Array.isArray(report.russianNav) && report.russianAgents === true && report.englishBack === true,
  'layout CODE: running shell docked below the editor (output kept)': report.layoutCodeTerminalDocked === true,
  'layout AI PAIR: chat beside the code, terminal below': report.layoutAiPair === true,
  'layout saved under a name, shell still alive on the right': report.layoutSaved === 'SMOKE LAYOUT' && report.layoutSavedShellAlive === true,
  'back to CLASSIC: same shell in the TERMINAL section': report.layoutClassicShellAlive === true,
  'saved layout stored in settings': report.layoutSettings?.active === 'classic' && (report.layoutSettings?.saved ?? []).includes('SMOKE LAYOUT:right+chat'),
  'model sources: NETRUNNER folder + LM Studio entry shown': Array.isArray(report.modelSources) && report.modelSources.length === 2 && report.modelSources[1].source === 'lmstudio',
  'agent control: PARALLEL picker 1–4': report.lanesPicker === 4,
  'git view rendered': report.gitViewRendered === true,
  'agent control rendered with engine status': /OPENCODE (STOPPED|RUNNING|ERROR|STARTING)/.test(report.agentEngineStatus ?? ''),
  'system monitor: measured CPU load shown': /LOAD \d+%/.test(report.systemCpu ?? ''),
  'system monitor: GPU utilization/VRAM from nvidia-smi': /UTIL \d+%.*VRAM/.test(report.systemGpu ?? ''),
  'system monitor: widget hidden via CUSTOMIZE': report.disksWidgetHidden === true,
  'network monitor: renderer request to the internet blocked': /^blocked/.test(report.rendererFetch ?? ''),
  'network monitor: block appears in the activity log': report.networkLogShowsBlock === true,
  'network monitor: 4 enforcement layers listed': report.enforcementLayers === 4,
  'network monitor: firewall status read (no change made), NETRUNNER programs listed': Array.isArray(report.firewallStatus?.programs) && report.firewallStatus.programs.some(p => /opencode\.exe$/i.test(p.path)),
}
if (agentModel) {
  let testsPass = false
  try {
    execFileSync('node', ['--test'], { cwd: workspace, stdio: 'ignore' })
    testsPass = true
  } catch {
    /* still failing */
  }
  checks['memory: index built through the UI'] = report.memoryIndexed === true
  checks['memory: semantic search ranks src/cart.js first'] = /src\/cart\.js/.test(report.memoryTopHit ?? '')
  checks['agent engine started (OpenCode)'] = report.agentEngineRunning === true
  checks['pipeline queued 4 role tasks'] = report.pipelineQueued === true
  checks['pipeline ran ARCHITECT → CODER → DEBUGGER → REVIEWER, all done'] =
    JSON.stringify(report.pipelineTasks) === JSON.stringify(['architect:done', 'coder:done', 'debugger:done', 'reviewer:done'])
  checks['agent asked for approvals and each was clicked in the UI'] = (report.agentApprovals ?? []).length > 0
  checks['review offered after the run'] = report.agentReviewOffered === true
  checks['diff review lists src/cart.js'] = (report.reviewFiles ?? []).some(f => /src\/cart\.js/.test(f))
  checks['monaco diff editor shows the change'] = report.diffEditorMounted === true
  checks['independent check: npm test passes after the agent'] = testsPass
  console.log(`pipeline facts: ${JSON.stringify(report.pipelineFacts)}\nworkspace switch: ${JSON.stringify(report.workspaceSwitch)}`)
  const facts = report.pipelineFacts ?? []
  console.log(`always: ${JSON.stringify({ granted: report.alwaysGranted, grants: report.standingGrants, shown: report.autoApprovedShown })}`)
  if (report.alwaysGranted) checks['agents: ALWAYS keeps exactly the approved command (NETRUNNER grant, shown in the list)'] = (report.standingGrants ?? []).length === 1 && /^bash:/.test(report.standingGrants[0].key)
  checks['pipeline: steps 2-4 got verified facts (git diff + tool log)'] = facts.length >= 3 && facts.every(f => f.facts) && facts.some(f => f.diff)
  const sw = report.workspaceSwitch ?? {}
  checks['agents: switching the project restarts the engine there with the same model'] = sw.moved === true && sw.sameModel === true && sw.after !== sw.before
  if (process.env.NETRUNNER_SMOKE_AGENT_WEB) {
    console.log(`agent web: ${JSON.stringify(report.agentWeb, null, 2)}`)
    const w = report.agentWeb ?? {}
    checks['agents: web search through NETRUNNER MCP tools'] = w.status === 'done' && (w.tools ?? []).some(t => /web_search:completed/.test(t))
  }
  const persisted = restart?.report?.persisted
  console.log(`restart: ${JSON.stringify(persisted)}`)
  checks['after restart: task queue history persisted'] = restart?.code === 0 && (persisted?.tasks ?? []).filter(t => t.endsWith(':done')).length >= 4
  checks['after restart: memory index persisted'] = (persisted?.chunks ?? 0) > 0
  checks['system monitor: agent task durations per role'] = /ARCHITECT.*CODER.*DEBUGGER.*REVIEWER/.test(report.agentPerfWidget ?? '')
  checks['system monitor: agent speed measured (tok/s per role)'] = /ARCHITECT[^·]*·[^·]*·[^·]*tok\/s/.test(report.agentPerfWidget ?? '')
}
checks['after restart: customized widget layout persisted'] = restart?.code === 0 && restart.report?.disksWidgetHiddenAfterRestart === true
checks['after restart: saved workspace layout persisted'] = (restart?.report?.layoutsAfterRestart ?? []).includes('SMOKE LAYOUT')
if (chatModel) {
  checks[`neural core streamed a reply from ${chatModel}`] = report.chatCompleted === true && /NETRUNNER ONLINE/i.test(report.chatReply ?? '')
  checks['real inference metrics shown'] = /tok\/s/.test(report.chatMetrics ?? '')
  checks['chat history search finds the conversation'] = (report.chatSearchHits ?? 0) > 0
  checks['no reasoning tags leaked into the answer'] = !/<\/?think>/.test(report.chatReply ?? '')
  const chatLabel = chatModel.split('/').pop().replace(/\.gguf$/i, '')
  checks['system monitor: chat run recorded in inference performance'] = (report.inferenceWidget ?? '').includes(chatLabel) && /tok\/s/.test(report.inferenceWidget ?? '')
}
if (process.env.NETRUNNER_SMOKE_TUNE) {
  const tune = report.tune ?? {}
  console.log(`tune: ${tune.text}`)
  checks['autotuner: TUNE shows progress and a measured result on the model card'] = tune.sawProgress === true && tune.done === true && !!tune.profile?.defaults?.genTokPerS
  checks['autotuner: every candidate measured or its error recorded, defaults measured twice when a change is kept'] =
    (tune.profile?.tried ?? []).every(t => t.result || t.error) && (!Object.keys(tune.profile?.profile ?? {}).length || !!tune.profile?.defaultsAgain)
}
if (process.env.NETRUNNER_SMOKE_RI) {
  const ri = report.ri ?? {}
  const kinds = s => (s?.findings ?? []).map(f => f.kind)
  console.log(`ri: ${JSON.stringify({ before: kinds(ri.before), during: kinds(ri.during), after: kinds(ri.after), badgeBefore: ri.badgeBefore, badgeDuring: ri.badgeDuring, ownDuring: ri.during?.own, totalDuring: ri.during?.total })}`)
  checks['interference: monitor active with a model loaded, no CPU finding before'] = ri.before?.active === true && !kinds(ri.before).includes('cpu-contention')
  checks['interference: busy CPU next to the model is reported and shown'] = kinds(ri.during).includes('cpu-contention') && /INTERFERENCE|ПОМЕХИ/.test(ri.badgeDuring ?? '') && (ri.widget ?? '').length > 0
  checks['interference: the finding ends when the load is gone'] = !kinds(ri.after).includes('cpu-contention') && (ri.after?.history ?? []).some(h => h.kind === 'cpu-contention')
}
if (process.env.NETRUNNER_SMOKE_A11Y) {
  const a11y = report.a11y ?? null
  if (a11y) for (const [id, v] of Object.entries(a11y)) console.log(`a11y ${id} [${v.impact}] ${v.nodes} node(s)
${v.sample}`)
  checks['accessibility: no WCAG 2.1 A/AA violations (axe-core) in any section'] = !!a11y && Object.keys(a11y).length === 0
}
if (ci) {
  checks['CI: no runtime, and the status says so'] = report.runtime?.reachable === false
  checks['CI: setup checklist lists what is missing'] = !!report.setup && Object.values(report.setup).length >= 8 && Object.values(report.setup).some(ok => !ok)
} else {
  // llama-fit-params placement on every model card (a missing plan means the card fell back to no estimate).
  checks['MODEL VAULT: llama.cpp placement plan on every model'] = !!report.fitPlans && Object.values(report.fitPlans).every(Boolean)
  // NSC-ME У2: defaults of a fresh profile — small models after 10 min, large ones never.
  checks['MODEL VAULT: idle models panel with defaults (small 10 min, large never)'] = report.idleUnload?.small === '10' && report.idleUnload?.large === '0'
  // NSC-ME У1: VRAM SAVER on MoE chat cards; turning it on is stored, turning it off again works.
  checks['MODEL VAULT: VRAM SAVER on MoE cards toggles and is stored'] = (report.vramSaver?.cards?.length ?? 0) > 0 && report.vramSaver.toggle?.on === 'on' && report.vramSaver.toggle?.stored === true && report.vramSaver.toggle?.off === 'off'
  checks['llama.cpp runtime available'] = report.runtime?.reachable === true && report.runtime?.backend === 'llama.cpp'
  checks['model vault lists installed models'] = Array.isArray(report.vaultModels) && report.vaultModels.length > 0
  checks['setup checklist: every item ready on this machine'] = !!report.setup && Object.values(report.setup).length >= 8 && Object.values(report.setup).every(ok => ok)
}
if (process.env.NETRUNNER_SMOKE_TUNED_MODEL) {
  // Objective checks on the answers of the FORGE model (the questions are about a file held out of training).
  checks['tuned model: memory index built'] = report.tunedMemoryIndexed === true
  checks['tuned model: names benchSummary in forge.ts from memory'] = /benchSummary/.test(report.tunedMemoryEn?.text ?? '') && /forge\.ts/.test(report.tunedMemoryEn?.text ?? '')
  // Russian: the app part is a Russian reply. Whether the model answered or refused is model quality, not an app
  // check, so it is printed (a refusal is checked first: its text lists the files it was given).
  const ru = report.tunedMemoryRu?.text ?? ''
  const ruRefuses = /(нет|не могу)/i.test(ru) && /фрагмент/i.test(ru)
  checks['tuned model: replies to the Russian question in Russian'] = /[а-яё]{4}/i.test(ru)
  console.log(`tuned model, Russian question: ${ruRefuses ? 'REFUSED (said the fragments have no answer)' : /forge\.ts/.test(ru) ? 'answered, citing forge.ts' : 'answered without citing forge.ts'}`)
  checks['tuned model: reads the image (FALCON 73, red circle)'] = report.tunedVision?.images > 0 && /falcon/i.test(report.tunedVision?.text ?? '') && /73/.test(report.tunedVision?.text ?? '') && /red/i.test(report.tunedVision?.text ?? '')
}
if (process.env.NETRUNNER_SMOKE_WEB_MODEL) {
  const s = report.webSearch ?? {}
  const r = report.webRepo ?? {}
  console.log(`web search: ${JSON.stringify(s, null, 2)}\nweb repo: ${JSON.stringify(r, null, 2)}`)
  const used = (x, name) => (x.tools ?? []).some(t => t.name === name && t.status === 'done')
  checks['web: WEB TOOLS panel in NETWORK'] = /PERMISSION|РАЗРЕШЕНИЕ/.test(report.webToolsPanel ?? '')
  const fnd = report.webFind ?? {}
  console.log(`web find: ${JSON.stringify(fnd, null, 2)}`)
  checks['web: the model read a page from the internet'] = used(s, 'fetch_url')
  checks['web: the model searched and listed results with URLs'] = used(fnd, 'web_search') && (fnd.text?.match(/https?:\/\//g) ?? []).length >= 3
  // A tag alone proves nothing (a model can invent one): it must come after the model looked it up.
  checks['web: the answer names a release tag it looked up'] = (used(s, 'web_search') || used(s, 'fetch_url')) && /\bb\d{4,5}\b/.test(s.text ?? '')
  if (process.env.NETRUNNER_SMOKE_WEB_REPO) checks['web: the model cloned, read and installed a repository'] = used(r, 'repo_clone') && (used(r, 'repo_read') || /README/.test(JSON.stringify(r.tools ?? []))) && used(r, 'repo_install')
}
if (process.env.NETRUNNER_SMOKE_FILE_MODEL) {
  const cf = report.chatFiles ?? {}
  console.log(`chat files: ${JSON.stringify(cf, null, 2)}`)
  checks['chat files: LIMITED creates a new file from the answer'] = cf.createStatus === 'created' && /def greet/.test(cf.createdOnDisk ?? '')
  checks['chat files: LIMITED does not overwrite without asking'] = cf.updateStatusLimited === 'pending' && cf.diskAfterLimited === cf.createdOnDisk
  checks['chat files: FULL saves the update on SAVE'] = cf.updateStatusFull === 'overwritten' && /def farewell/.test(cf.diskAfterSave ?? '')
  checks['chat files: UNDO restores the previous content'] = cf.statusAfterUndo === 'undone' && cf.diskAfterUndo === cf.createdOnDisk
}
if (process.env.NETRUNNER_SMOKE_FORGE) {
  checks['FORGE run from the UI finished'] = report.forgeState?.status === 'done'
  checks['FORGE run trained and exported a model'] = !!report.forgeRun?.training && !!report.forgeRun?.exportedModel
}
console.log(`startup: ${report.startupMs} ms from process start to interactive shell`)
let failed = 0
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
