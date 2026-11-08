import { app, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Type text into the focused element. Characters go as `char` events (exact text, no keyboard-layout mapping);
 * a Shift press first gives a fresh xterm the key-down it always sees from a real keyboard before the first
 * character (without it xterm drops the first synthetic keypress).
 */
async function typeText(win: BrowserWindow, text: string): Promise<void> {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' })
  await delay(20)
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await delay(5)
  }
}

/** Bring the window up and wait for a fresh frame so the capture shows the current DOM. */
async function freshShot(win: BrowserWindow, file: string): Promise<void> {
  win.showInactive()
  win.webContents.invalidate()
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', true)
  await delay(300)
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
}

/**
 * Automated smoke run, enabled only by NETRUNNER_SMOKE_OUT. Drives the real UI through the DOM,
 * records what actually happened, saves screenshots and exits. Never reports success it did not observe.
 */
export async function runSmokeTest(win: BrowserWindow, outDir: string): Promise<void> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>
  const waitFor = async (code: string, timeoutMs = 15000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await js<boolean>(code).catch(() => false)) return true
      await delay(200)
    }
    return false
  }

  try {
    await fs.mkdir(outDir, { recursive: true })
    report.shellRendered = await waitFor(`!!document.querySelector('[data-testid="titlebar"]')`)
    // Process start → interactive shell (includes Electron boot, DB open/migrations, renderer load).
    report.startupMs = Math.round(process.uptime() * 1000)
    report.rendererIsolation = await js(`({ hasApi: typeof window.netrunner === 'object', hasProcess: typeof process !== 'undefined', hasRequire: typeof require !== 'undefined' })`)
    report.workspace = await js(`window.netrunner.invoke('workspace:current')`)
    // What survived from a previous run with the same user data (checked by the restart pass).
    report.persisted = await js(`Promise.all([
      window.netrunner.invoke('tasks:list'),
      window.netrunner.invoke('memory:status').catch(() => null),
    ]).then(([tasks, mem]) => ({ tasks: tasks.map(t => t.role + ':' + t.status), chunks: mem ? mem.chunks : null }))`)
    if (process.env.NETRUNNER_SMOKE_PERSIST_ONLY) {
      await js(`document.querySelector('[data-section="system"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="system-widgets"]')`, 15000)
      report.disksWidgetHiddenAfterRestart = await js(`!document.querySelector('[data-widget="disks"]')`)
      report.layoutsAfterRestart = await js(`window.netrunner.invoke('settings:get').then(s => s.layouts.map(l => l.name))`)
      report.ok = true
      report.finishedAt = new Date().toISOString()
      await fs.writeFile(path.join(outDir, 'smoke-report-restart.json'), JSON.stringify(report, null, 2))
      // The normal quit path (before-quit cleanup), as when the user closes the window; app.exit() would skip it.
      app.quit()
      return
    }

    const file = process.env.NETRUNNER_SMOKE_FILE
    if (file) {
      const selector = JSON.stringify(`[data-path=${JSON.stringify(file)}]`)
      report.explorerHasFile = await waitFor(`!!document.querySelector(${selector})`)
      await js(`document.querySelector(${selector})?.click()`)
      report.editorMounted = await waitFor(`!!document.querySelector('.monaco-editor .view-lines')`)
      await delay(800)
      report.editorFirstLine = await js(`document.querySelector('.monaco-editor .view-line')?.textContent ?? null`)
      report.tokenized = await js(`document.querySelectorAll('.monaco-editor .view-line span[class^="mtk"]').length > 1`)
    }

    await delay(500)
    await freshShot(win, path.join(outDir, 'smoke.png'))

    report.paletteOpened = await (async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] })
      return waitFor(`!!document.querySelector('[data-testid="command-palette"]')`, 3000)
    })()
    if (report.paletteOpened) {
      await delay(400) // let the fade-in finish
      await freshShot(win, path.join(outDir, 'smoke-palette.png'))
    }
    if (report.paletteOpened) win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })

    // ----- Phase 2: local runtime -----
    report.runtime = await js(`window.netrunner.invoke('runtime:status')`)
    report.pullBlockedOffline = await js(
      `window.netrunner.invoke('models:pull', 'Qwen/Qwen3-0.6B-GGUF:Q8_0').then(() => 'NOT BLOCKED', e => String(e.message))`,
    )
    await js(`document.querySelector('[data-section="models"]').click()`)
    report.vaultModels = (await waitFor(`document.querySelectorAll('[data-model]').length > 0`, 20000))
      ? await js(`[...document.querySelectorAll('[data-model]')].map(e => e.getAttribute('data-model'))`)
      : []
    await delay(1500)
    report.setup = (await waitFor(`document.querySelectorAll('[data-testid="setup-checklist"] [data-setup]').length > 0`, 30000))
      ? await js(`Object.fromEntries([...document.querySelectorAll('[data-setup]')].map(e => [e.getAttribute('data-setup'), e.getAttribute('data-ok') === 'true']))`)
      : null
    report.modelSources = (await waitFor(`!!document.querySelector('[data-testid="model-sources"] [data-source="lmstudio"]')`, 10000))
      ? await js(`window.netrunner.invoke('models:sources')`)
      : null
    // llama-fit-params' placement per model card (layers on the GPU / total / MoE layers with experts in RAM).
    // Cards ask one by one (~2 s each), so wait for every card that will get a plan, not just the first.
    await waitFor(`document.querySelectorAll('[data-fit-plan]').length >= document.querySelectorAll('[data-model]').length`, 90000)
    report.fitPlans = (await waitFor(`document.querySelectorAll('[data-fit-plan]').length > 0`, 1000))
      ? await js(`Object.fromEntries([...document.querySelectorAll('[data-model]')].map(c => [c.getAttribute('data-model'), c.querySelector('[data-fit-plan]')?.getAttribute('data-fit-plan') ?? null]))`)
      : null
    // NSC-ME: idle-model panel with its defaults, and VRAM SAVER on MoE chat cards (toggled on and off again).
    report.idleUnload = (await waitFor(`!!document.querySelector('[data-testid="idle-smallMinutes"]')`, 10000))
      ? await js(`({ small: document.querySelector('[data-testid="idle-smallMinutes"]').value, large: document.querySelector('[data-testid="idle-largeMinutes"]').value })`)
      : null
    const saverCards = (await js(`[...document.querySelectorAll('[data-vram-saver]')].map(e => e.getAttribute('data-vram-saver'))`)) as string[]
    let saverToggle: { on: string | null; stored: boolean; off: string | null } | null = null
    if (saverCards.length) {
      const sel = `[data-vram-saver="${saverCards[0].replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
      await js(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-testid="vram-saver-toggle"]').click()`)
      await waitFor(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-vram-saver-state]')?.getAttribute('data-vram-saver-state') === 'on'`, 5000)
      const on = (await js(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-vram-saver-state]').getAttribute('data-vram-saver-state')`)) as string
      const stored = (await js(`window.netrunner.invoke('settings:get').then(s => s.vramSaver.includes(${JSON.stringify(saverCards[0])}))`)) as boolean
      await js(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-testid="vram-saver-toggle"]').click()`)
      await waitFor(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-vram-saver-state]')?.getAttribute('data-vram-saver-state') === 'off'`, 5000)
      const off = (await js(`document.querySelector(${JSON.stringify(sel)}).querySelector('[data-vram-saver-state]').getAttribute('data-vram-saver-state')`)) as string
      saverToggle = { on, stored, off }
    }
    report.vramSaver = { cards: saverCards, toggle: saverToggle }
    await freshShot(win, path.join(outDir, 'smoke-vault.png'))

    // ----- Phase 3: terminal, git, agent control -----
    await js(`document.querySelector('[data-section="terminal"]').click()`)
    report.terminalReady = await waitFor(`!!document.querySelector('[data-testid="terminal"] .xterm-rows') && /PS .*>/.test(document.querySelector('[data-testid="terminal"] .xterm-rows').innerText)`, 30000)
    if (report.terminalReady) {
      // Type into xterm's hidden textarea exactly like a user; the keystrokes go to the real ConPTY shell.
      await js(`document.querySelector('[data-testid="terminal"] textarea').focus()`)
      await typeText(win, 'Write-Output ("PTY_" + (6*7))')
      await delay(300)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      report.terminalCommand = await waitFor(`/PTY_42/.test(document.querySelector('[data-testid="terminal"] .xterm-rows').innerText)`, 20000)
      await freshShot(win, path.join(outDir, 'smoke-terminal.png'))

      // A second shell in its own tab: separate output, the first one keeps its own.
      await js(`document.querySelector('[title="New terminal tab"]').click()`)
      report.terminalTab2 = await waitFor(`document.querySelector('[data-terminal-tab="2"]')?.getAttribute('data-active') === 'true' && /PS .*>/.test(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`, 30000)
      if (report.terminalTab2) {
        await js(`document.querySelector('[data-testid="terminal"] textarea').focus()`)
        await delay(300)
        await typeText(win, 'Write-Output ("TAB_" + (6*8))')
        await delay(300)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        report.terminalTab2Command = await waitFor(`/TAB_48/.test(document.querySelector('[data-testid="terminal"] .xterm-rows').innerText)`, 20000)
        await freshShot(win, path.join(outDir, 'smoke-terminal-tabs.png'))
        await js(`document.querySelector('[data-terminal-tab="1"]').click()`)
        report.terminalTab1Kept = await waitFor(`(() => { const t = document.querySelector('[data-testid="terminal"] .xterm-rows').innerText; return /PTY_42/.test(t) && !/TAB_48/.test(t) })()`, 10000)
      }
    }

    // ----- Explorer: new file through the UI; an outside write reaches the open tab; pyright checks it -----
    {
      const root = ((await js<{ root: string } | null>(`window.netrunner.invoke('workspace:current')`)) ?? { root: '' }).root
      const probe = path.join(root, 'netrunner_smoke_probe.py')
      await fs.rm(probe, { force: true })
      await js(`document.querySelector('[data-section="editor"]').click()`)
      await delay(300)
      await js(`document.querySelector('[title="New file"]').click()`)
      if (await waitFor(`!!document.querySelector('[data-testid="explorer-name"]')`, 5000)) {
        await js(`(() => {
          const inp = document.querySelector('[data-testid="explorer-name"]');
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(inp, 'netrunner_smoke_probe.py'); inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()`)
      }
      report.explorerCreated = await waitFor(`!!document.querySelector('[data-tab="netrunner_smoke_probe.py"]') && !!document.querySelector('[data-path="netrunner_smoke_probe.py"]')`, 10000)
      // Written by "someone else" (here: the main process, like an agent or git would).
      await fs.writeFile(probe, 'def greet(name: str) -> str:\n    return "hi " + name\n\n\nx: int = greet("netrunner")\n')
      report.diskChangeShown = await waitFor(`/def\\s+greet/.test(document.querySelector('.monaco-editor .view-lines')?.innerText ?? '')`, 15000)
      report.lspDiagnostics = await waitFor(`!!document.querySelector('.monaco-editor .squiggly-error')`, 60000)
      report.lspHover = await js(`window.netrunner.invoke('lsp:request', 'netrunner_smoke_probe.py', 'hover', { line: 4, character: 10 }).then(r => r && r.contents ? r.contents.value : null, e => 'error: ' + e.message)`)
      report.lspStatus = await js(`window.netrunner.invoke('lsp:status').then(s => s.find(x => x.id === 'python'))`)
      await freshShot(win, path.join(outDir, 'smoke-lsp.png'))
      await js(`document.querySelector('[aria-label="Close netrunner_smoke_probe.py"]')?.click()`)
      await fs.rm(probe, { force: true })
      report.explorerSawDelete = await waitFor(`!document.querySelector('[data-path="netrunner_smoke_probe.py"]')`, 10000)
    }

    // ----- Workspace layouts: dock the running shell under the editor, chat beside the code, save a layout -----
    const pickLayout = async (id: string) => {
      await js(`document.querySelector('[data-testid="layout-menu"]').click()`)
      await waitFor(`!!document.querySelector('[data-layout="${id}"]')`, 3000)
      await js(`document.querySelector('[data-layout="${id}"]').click()`)
      await delay(600)
    }
    await pickLayout('code')
    report.layoutCodeTerminalDocked = await waitFor(
      `(() => { const t = document.querySelector('[data-testid="layout-bottom"] [data-testid="terminal"] .xterm-rows'); return !!t && /PTY_42/.test(t.innerText) })()`,
      10000,
    )
    await freshShot(win, path.join(outDir, 'smoke-layout-code.png'))
    await pickLayout('ai-pair')
    report.layoutAiPair = await waitFor(
      `!!document.querySelector('[data-testid="layout-right"]') && !!document.querySelector('[data-testid="layout-bottom"] [data-testid="terminal"]')`,
      10000,
    )
    await freshShot(win, path.join(outDir, 'smoke-layout-ai-pair.png'))
    // Change the built-in preset (terminal to the right) and save it under a name.
    await js(`document.querySelector('[data-testid="layout-menu"]').click()`)
    await waitFor(`!!document.querySelector('[data-terminal-dock="right"]')`, 3000)
    await js(`document.querySelector('[data-terminal-dock="right"]').click()`)
    await delay(300)
    await js(`(() => {
      const inp = document.querySelector('[data-testid="layout-name"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, 'SMOKE LAYOUT'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await delay(200)
    await js(`document.querySelector('[data-testid="layout-save"]').click()`)
    await delay(600)
    report.layoutSaved = await js(`document.querySelector('[data-testid="layout-current"]').innerText`)
    report.layoutSavedShellAlive = await waitFor(`/PTY_42/.test(document.querySelector('[data-testid="layout-right"] [data-testid="terminal"] .xterm-rows')?.innerText ?? '')`, 10000)
    await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await freshShot(win, path.join(outDir, 'smoke-layout-saved.png'))
    await pickLayout('classic')
    await js(`document.querySelector('[data-section="terminal"]').click()`)
    report.layoutClassicShellAlive = await waitFor(`/PTY_42/.test(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`, 10000)
    report.layoutSettings = await js(`window.netrunner.invoke('settings:get').then(s => ({ active: s.activeLayout, saved: s.layouts.map(l => l.name + ':' + l.terminal + (l.chat ? '+chat' : '')) }))`)
    await js(`document.querySelector('[data-section="git"]').click()`)
    report.gitViewRendered = await waitFor(`/GIT INIT|CHECKPOINTS/.test(document.body.innerText)`, 15000)
    await js(`document.querySelector('[data-section="agents"]').click()`)
    report.agentEngineStatus = (await waitFor(`!!document.querySelector('[data-testid="agent-engine-status"]')`, 15000))
      ? await js(`document.querySelector('[data-testid="agent-engine-status"]').innerText`)
      : null
    report.lanesPicker = await js(`document.querySelectorAll('[data-lanes]').length`)
    await freshShot(win, path.join(outDir, 'smoke-agents.png'))

    // ----- Phase 5: system monitor, widget customization, network monitor -----
    await js(`document.querySelector('[data-section="system"]').click()`)
    report.systemCpu = (await waitFor(`/LOAD\\s*\\d+%/.test(document.querySelector('[data-testid="widget-cpu"]')?.innerText ?? '')`, 20000))
      ? await js(`document.querySelector('[data-testid="widget-cpu"]').innerText.replace(/\\s+/g, ' ')`)
      : null
    report.systemGpu = (await waitFor(`!!document.querySelector('[data-testid="widget-gpu"]')`, 10000))
      ? await js(`document.querySelector('[data-testid="widget-gpu"]').innerText.replace(/\\s+/g, ' ')`)
      : null
    // Hide the DISKS widget through the CUSTOMIZE mode; the choice must survive a restart.
    if (!process.env.NETRUNNER_SMOKE_PERSIST_ONLY) {
      await js(`document.querySelector('[data-testid="customize-widgets"]').click()`)
      await delay(200)
      await js(`document.querySelector('[data-widget="disks"] [aria-label="Hide"]').click()`)
      await js(`document.querySelector('[data-testid="customize-widgets"]').click()`)
      await delay(300)
    }
    report.disksWidgetHidden = await js(`!document.querySelector('[data-widget="disks"]')`)
    await delay(2500)
    await freshShot(win, path.join(outDir, 'smoke-system.png'))

    await js(`document.querySelector('[data-section="network"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="network-log"]')`, 15000)
    // A real attempt by the UI to reach the internet: the renderer guard must cancel and log it.
    report.rendererFetch = await js(`fetch('https://example.com/netrunner-smoke').then(() => 'NOT BLOCKED', e => 'blocked: ' + e.message)`)
    report.networkLogShowsBlock = await waitFor(
      `[...document.querySelectorAll('[data-testid="network-log"] tbody tr')].some(r => /example\\.com/.test(r.innerText) && /BLOCK/.test(r.innerText) && /renderer/.test(r.innerText))`,
      10000,
    )
    report.enforcementLayers = await js(`document.querySelectorAll('[data-testid="enforcement"] li').length`)
    report.firewallStatus = await js(`window.netrunner.invoke('firewall:status')`)
    await freshShot(win, path.join(outDir, 'smoke-network.png'))

    const agentModel = process.env.NETRUNNER_SMOKE_AGENT_MODEL
    if (agentModel) {
      // ----- Phase 4: memory index + semantic search through the MEMORY screen -----
      await js(`document.querySelector('[data-section="memory"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="memory-index"]')`, 15000)
      await js(`document.querySelector('[data-testid="memory-index"]').click()`)
      report.memoryIndexed = await waitFor(`/CHUNKS\\s+[1-9]/.test(document.querySelector('[data-testid="memory-status"]').innerText)`, 300000)
      await js(`(() => {
        const inp = document.querySelector('[data-testid="memory-query"]');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(inp, 'how is the shopping cart total with a discount calculated'); inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await delay(200)
      await js(`document.querySelector('[data-testid="memory-search"]').click()`)
      report.memoryTopHit = (await waitFor(`document.querySelectorAll('[data-testid="memory-hits"] li button').length > 0`, 60000))
        ? await js(`document.querySelector('[data-testid="memory-hits"] li button').innerText.replace(/\\s+/g, ' ')`)
        : null
      report.memorySearchMode = await js(`document.querySelector('[data-testid="memory-search-mode"]')?.value ?? null`)
      await freshShot(win, path.join(outDir, 'smoke-memory.png'))
      await js(`document.querySelector('[data-section="agents"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="agent-model"]')`, 15000)

      // ----- Multi-agent pipeline driven through the UI -----
      await js(`(() => {
        const sel = document.querySelector('[data-testid="agent-model"]');
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(sel, ${JSON.stringify(agentModel)}); sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await delay(300)
      await js(`document.querySelector('[data-testid="agent-start"]').click()`)
      // The agent model (tens of GB) loads before OpenCode starts; allow for a cold disk.
      report.agentEngineRunning = await waitFor(`/OPENCODE RUNNING/.test(document.querySelector('[data-testid="agent-engine-status"]').innerText)`, 15 * 60_000)
      await js(`document.querySelector('[data-testid="agent-memory"]').click()`)
      await js(`(() => {
        const ta = document.querySelector('[data-testid="agent-input"]');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(ta, 'The test suite of this project (npm test) fails. Make all tests pass by fixing the bug in the source code.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await delay(300)
      await js(`document.querySelector('[data-testid="agent-pipeline"]').click()`)
      report.pipelineQueued = await waitFor(`document.querySelectorAll('[data-task]').length >= 4`, 15000)

      const approvals: string[] = []
      const deadline = Date.now() + 40 * 60_000
      let shotTaken = false
      const settled = `(() => { const t = [...document.querySelectorAll('[data-task]')]; return t.length >= 4 && t.every(e => !['queued','running'].includes(e.getAttribute('data-task-status'))) })()`
      while (Date.now() < deadline) {
        const pending = await js<string | null>(
          `(() => { const c = document.querySelector('[data-permission]'); return c ? c.getAttribute('data-permission') + ': ' + c.innerText.split('\\n').slice(0, 3).join(' | ') : null })()`,
        )
        if (pending) {
          if (!shotTaken) {
            await freshShot(win, path.join(outDir, 'smoke-approval.png'))
            shotTaken = true
          }
          approvals.push(pending)
          // The first test run is approved with ALWAYS: later identical runs must pass on their own, nothing broader.
          const always = !report.alwaysGranted && /^bash: .*(npm test|node --test)/.test(pending)
          if (always) report.alwaysGranted = pending
          await js(`[...document.querySelectorAll('[data-permission] button')].find(b => ${always ? "/ALWAYS/.test(b.innerText)" : "b.getAttribute('data-approve') === 'once'"})?.click()`)
          await delay(800)
          continue
        }
        if (await js<boolean>(settled)) break
        await delay(1000)
      }
      report.agentApprovals = approvals
      report.standingGrants = await js(`window.netrunner.invoke('agent:grants')`)
      report.autoApprovedShown = await js(`document.querySelectorAll('[data-auto-approved]').length`)
      report.pipelineTasks = await js(`[...document.querySelectorAll('[data-task]')].map(e => e.getAttribute('data-task-role') + ':' + e.getAttribute('data-task-status')).reverse()`)
      await freshShot(win, path.join(outDir, 'smoke-agent-run.png'))
      // Review the CODER step: that is where the source was edited.
      await js(`document.querySelector('[data-task-role="coder"] [role="button"]').click()`)
      report.agentReviewOffered = await waitFor(`!!document.querySelector('[data-testid="review-changes"]')`, 30000)
      report.agentTools = await js(`[...document.querySelectorAll('[data-tool]')].map(e => e.getAttribute('data-tool') + ':' + e.getAttribute('data-tool-status'))`)
      await freshShot(win, path.join(outDir, 'smoke-agent-coder.png'))
      if (report.agentReviewOffered) {
        await js(`document.querySelector('[data-testid="review-changes"]').click()`)
        report.reviewFiles = (await waitFor(`document.querySelectorAll('[data-testid="changed-files"] button').length > 0`, 20000))
          ? await js(`[...document.querySelectorAll('[data-testid="changed-files"] button')].map(b => b.innerText.replace(/\\s+/g, ' '))`)
          : []
        report.diffEditorMounted = await waitFor(`!!document.querySelector('.monaco-diff-editor')`, 20000)
        await delay(1500)
        await freshShot(win, path.join(outDir, 'smoke-review.png'))
      }
      // While the agent model is loaded, a chat with another model is answered by the agent model instead of
      // unloading it; the reply says so.
      const routedChat = process.env.NETRUNNER_SMOKE_CHAT_MODEL
      if (routedChat && routedChat !== agentModel) {
        await js(`document.querySelector('[data-section="neural"]').click()`)
        await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`, 20000)
        await js(`(() => {
          const sel = document.querySelector('[data-testid="chat-model"]');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(routedChat)}); sel.dispatchEvent(new Event('change', { bubbles: true }));
          const ta = document.querySelector('[data-testid="chat-input"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Reply with one word: ROUTED'); ta.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await delay(300)
        const t0 = Date.now()
        await js(`document.querySelector('[data-testid="chat-send"]').click()`)
        report.routedChatServedBy = (await waitFor(`!!document.querySelector('[data-testid="served-by"]') || /ERROR:/.test(document.body.innerText)`, 120000))
          ? await js(`document.querySelector('[data-testid="served-by"]')?.innerText ?? document.body.innerText.match(/ERROR:.*/)?.[0] ?? null`)
          : null
        report.routedChatSeconds = Math.round((Date.now() - t0) / 1000)
        await freshShot(win, path.join(outDir, 'smoke-chat-routed.png'))
        await js(`document.querySelector('[title="New session"]')?.click()`)
      }

      // ----- Verified facts: steps 2-4 of the pipeline got the real diff and command log, not a summary -----
      report.pipelineFacts = await js(`(async () => {
        const tasks = (await window.netrunner.invoke('tasks:list')).filter(t => t.pipelineStep >= 1 && t.sessionId);
        const out = [];
        for (const t of tasks) {
          const parts = await window.netrunner.invoke('agent:history', t.sessionId).catch(() => []);
          const prompt = parts.filter(p => p.kind === 'text').map(p => p.text).find(x => /Verified facts/.test(x)) ?? '';
          out.push({ role: t.role, step: t.pipelineStep, facts: !!prompt, diff: /diff --git/.test(prompt), commands: /Command: \`/.test(prompt) });
        }
        return out;
      })()`)

      // Runs one agent task to its end, approving each request once (the operator's part).
      const runTask = async (role: string, prompt: string, minutes: number) => {
        const task = await js<{ id: number }>(`window.netrunner.invoke('tasks:enqueue', { role: ${JSON.stringify(role)}, prompt: ${JSON.stringify(prompt)}, useMemory: false })`)
        const end = Date.now() + minutes * 60_000
        const approvals: string[] = []
        while (Date.now() < end) {
          const pending = await js<string | null>(`(() => { const c = document.querySelector('[data-permission]'); return c ? c.getAttribute('data-permission') : null })()`)
          if (pending) {
            approvals.push(pending)
            await js(`document.querySelector('[data-permission] [data-approve="once"]').click()`)
            await delay(800)
            continue
          }
          const t = await js<{ status: string; sessionId: string | null; result: string | null; error: string | null }>(`window.netrunner.invoke('tasks:list').then(l => l.find(x => x.id === ${task.id}))`)
          if (!['queued', 'running'].includes(t.status)) {
            const parts = t.sessionId ? await js<{ kind: string; tool?: string; status?: string; text?: string }[]>(`window.netrunner.invoke('agent:history', ${JSON.stringify(t.sessionId)})`) : []
            return { status: t.status, approvals, tools: parts.filter(p => p.kind === 'tool').map(p => `${p.tool}:${p.status}`), answer: (t.result ?? t.error ?? parts.filter(p => p.kind === 'text').map(p => p.text).pop() ?? '').slice(0, 1500) }
          }
          await delay(1500)
        }
        return { status: 'timeout', approvals, tools: [], answer: '' }
      }

      // ----- Agents use NETRUNNER's web tools (MCP) in ONLINE TOOLS -----
      if (process.env.NETRUNNER_SMOKE_AGENT_WEB) {
        const mode = await js<string>(`window.netrunner.invoke('settings:get').then(s => s.networkMode)`)
        await js(`window.netrunner.invoke('settings:set-network-mode', 'online-tools')`)
        await js(`window.netrunner.invoke('settings:set-web-tools', 'limited')`)
        report.agentWeb = await runTask('architect', 'Use the web_search tool (NETRUNNER web tools) to find the latest release tag of the llama.cpp project (ggml-org/llama.cpp) and report the tag with the URL you read it from. Do not change any files.', 20)
        await js(`window.netrunner.invoke('settings:set-network-mode', ${JSON.stringify(mode)})`)
      }

      // ----- Switching the project while agents run restarts the engine there, same model -----
      const second = path.join(outDir, 'agent-workspace-2')
      const before = await js<{ workspace: string | null; model: string | null }>(`window.netrunner.invoke('agent:state')`)
      await js(`window.netrunner.invoke('workspace:open', ${JSON.stringify(second)})`)
      const t0 = Date.now()
      const moved = await waitFor(`window.netrunner.invoke('agent:state').then(s => s.status === 'running' && s.workspace === ${JSON.stringify(second)})`, 10 * 60_000)
      const after = await js<{ status: string; workspace: string | null; model: string | null }>(`window.netrunner.invoke('agent:state')`)
      report.workspaceSwitch = { before: before.workspace, after: after.workspace, status: after.status, sameModel: !!before.model && before.model === after.model, moved, seconds: Math.round((Date.now() - t0) / 1000) }
      await js(`window.netrunner.invoke('agent:stop')`)
      // Back to the first project (engine stopped, so nothing restarts): the restart checks read its memory index.
      if (before.workspace) await js(`window.netrunner.invoke('workspace:open', ${JSON.stringify(before.workspace)})`)
    }

    const chatModel = process.env.NETRUNNER_SMOKE_CHAT_MODEL
    if (chatModel) {
      await js(`document.querySelector('[data-section="neural"]').click()`)
      report.chatReady = await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`, 20000)
      // Select the model through the real <select>, then type and send like a user would.
      await js(`(() => {
        const sel = document.querySelector('[data-testid="chat-model"]');
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(sel, ${JSON.stringify(chatModel)}); sel.dispatchEvent(new Event('change', { bubbles: true }));
        const ta = document.querySelector('[data-testid="chat-input"]');
        const setT = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setT.call(ta, 'Reply with exactly the words: NETRUNNER ONLINE'); ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await delay(300)
      await js(`document.querySelector('[data-testid="chat-send"]').click()`)
      report.chatCompleted = await waitFor(`!!document.querySelector('[data-testid="chat-metrics"]') || /ERROR:/.test(document.body.innerText)`, 600000)
      report.chatReply = await js(`[...document.querySelectorAll('[data-role="assistant"]')].pop()?.innerText ?? null`)
      report.chatMetrics = await js(`document.querySelector('[data-testid="chat-metrics"]')?.innerText ?? null`)
      await delay(1500)
      await js(`(() => {
        const inp = document.querySelector('[data-testid="chat-search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'netrunner online');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      report.chatSearchHits = (await waitFor(`document.querySelectorAll('[data-testid="chat-sessions"] [data-session]').length > 0`, 10000))
        ? await js(`document.querySelectorAll('[data-testid="chat-sessions"] [data-session]').length`)
        : 0
      // capturePage can return the last composited frame; force a repaint first.
      await freshShot(win, path.join(outDir, 'smoke-chat.png'))
    }

    if (agentModel || chatModel) {
      // After real runs the performance widgets must show recorded measurements.
      await js(`document.querySelector('[data-section="system"]').click()`)
      report.inferenceWidget = (await waitFor(`!!document.querySelector('[data-testid="widget-inference"]')`, 15000))
        ? await js(`document.querySelector('[data-testid="widget-inference"]').innerText.replace(/\\s+/g, ' ')`)
        : null
      report.agentPerfWidget = await js(`document.querySelector('[data-widget="agents"]')?.innerText.replace(/\\s+/g, ' ') ?? null`)
      await delay(2500)
      await freshShot(win, path.join(outDir, 'smoke-system-after.png'))
    }
    // ----- A FORGE model in the chat: answers from project memory (EN and RU) and reads an image -----
    const tuned = process.env.NETRUNNER_SMOKE_TUNED_MODEL
    if (tuned) {
      await js(`document.querySelector('[data-section="memory"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="memory-index"]')`, 15000)
      if (!(await js<boolean>(`/CHUNKS\\s+[1-9]/.test(document.querySelector('[data-testid="memory-status"]').innerText)`))) {
        await js(`document.querySelector('[data-testid="memory-index"]').click()`)
      }
      report.tunedMemoryIndexed = await waitFor(`/CHUNKS\\s+[1-9]/.test(document.querySelector('[data-testid="memory-status"]').innerText)`, 900000)
      await js(`document.querySelector('[data-section="neural"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`, 20000)
      const ask = async (prompt: string, shot: string, setup: string) => {
        await js(`document.querySelector('[title="New session"]')?.click()`)
        await delay(300)
        await js(`(() => {
          const sel = document.querySelector('[data-testid="chat-model"]');
          const opt = [...sel.options].find(o => o.value.includes(${JSON.stringify(tuned)}));
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }));
        })()`)
        await delay(500)
        await js(setup)
        await delay(800)
        await js(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(prompt)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await delay(300)
        const before = await js<number>(`document.querySelectorAll('[data-testid="chat-metrics"]').length`)
        const t0 = Date.now()
        await js(`document.querySelector('[data-testid="chat-send"]').click()`)
        // Done = metrics under the new reply, or the message's own error line (the memory context in the question can
        // itself contain "ERROR:" from the source code, so the page text is no signal).
        const failure = `[...document.querySelectorAll('p.text-critical')].find(p => /ERROR:/.test(p.innerText))`
        const done = await waitFor(`document.querySelectorAll('[data-testid="chat-metrics"]').length > ${before} || !!${failure}`, 300000)
        const answer = done
          ? await js<{ text: string; metrics: string | null; images: number }>(`(() => {
              const msgs = [...document.querySelectorAll('[data-testid="chat-metrics"]')].map(m => m.parentElement);
              const last = msgs[msgs.length - 1];
              return { text: (last?.innerText ?? ${failure}?.innerText ?? '').slice(0, 1500),
                       metrics: last?.querySelector('[data-testid="chat-metrics"]')?.innerText ?? null,
                       images: document.querySelectorAll('[data-testid="message-images"] img').length };
            })()`)
          : null
        await freshShot(win, path.join(outDir, shot))
        return { prompt, seconds: Math.round((Date.now() - t0) / 1000), ...answer }
      }
      const memoryOn = `(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'MEMORY'); if (b && !b.className.includes('border-primary')) b.click() })()`
      // electron/main/services/forge.ts is one of the files FORGE held out of training.
      report.tunedMemoryEn = await ask('Which function turns bench_report.json into the per-suite numbers shown in the UI, and in which file is it?', 'smoke-tuned-memory-en.png', memoryOn)
      report.tunedMemoryRu = await ask('Какие шаги конвейера FORGE перечислены в STEPS и в каком файле?', 'smoke-tuned-memory-ru.png', memoryOn)
      // A drawn picture: the answer must read the text, which proves the vision projector is in use.
      const memoryOff = `(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'MEMORY'); if (b?.className.includes('border-primary')) b.click() })()`
      report.tunedVision = await ask('What word and number are written in this image, and what colour is the circle?', 'smoke-tuned-vision.png', `${memoryOff}; (async () => {
        const c = document.createElement('canvas'); c.width = 480; c.height = 240;
        const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 480, 240);
        g.fillStyle = '#d01010'; g.beginPath(); g.arc(380, 120, 70, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#000000'; g.font = 'bold 56px Arial'; g.fillText('FALCON 73', 20, 140);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
        const inp = document.querySelector('[data-testid="chat-image-input"]');
        Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
    }
    // ----- Chat writes files: LIMITED creates a new file, waits on an overwrite; FULL saves it; UNDO restores -----
    const fileModel = process.env.NETRUNNER_SMOKE_FILE_MODEL
    if (fileModel) {
      const target = 'hello/greet.py'
      const blockSel = JSON.stringify(`[data-file-block="${target}"]`)
      const readFile = () => js<string | null>(`window.netrunner.invoke('fs:read', ${JSON.stringify(target)}).then(f => f.content, () => null)`)
      const setMode = (mode: string) =>
        js(`(() => { const s = document.querySelector('[data-testid="chat-file-writes"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(mode)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      const blockStatus = () => js<string | null>(`(() => { const b = [...document.querySelectorAll(${blockSel})].pop(); return b ? b.getAttribute('data-file-status') : null })()`)
      const askFile = async (prompt: string) => {
        const before = await js<number>(`document.querySelectorAll('[data-testid="chat-metrics"]').length`)
        await js(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(prompt)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await delay(300)
        const t0 = Date.now()
        await js(`document.querySelector('[data-testid="chat-send"]').click()`)
        await waitFor(`document.querySelectorAll('[data-testid="chat-metrics"]').length > ${before}`, 300000)
        await delay(1500) // the write runs after the answer is stored
        return Math.round((Date.now() - t0) / 1000)
      }
      await js(`document.querySelector('[data-section="neural"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`, 20000)
      await js(`document.querySelector('[title="New session"]')?.click()`)
      await delay(300)
      await js(`(() => {
        const sel = document.querySelector('[data-testid="chat-model"]');
        const opt = [...sel.options].find(o => o.value.includes(${JSON.stringify(fileModel)}));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await setMode('limited')
      await delay(500)
      const files: Record<string, unknown> = { model: fileModel }
      files.createSeconds = await askFile(`Create a new file ${target} with a function greet(name) that returns "Hello, " + name. Give the complete file.`)
      files.createStatus = await blockStatus()
      files.createdOnDisk = await readFile()
      files.updateSeconds = await askFile(`Now add a function farewell(name) that returns "Bye, " + name to ${target}. Give the complete updated file.`)
      files.updateStatusLimited = await blockStatus()
      files.diskAfterLimited = await readFile()
      await setMode('full')
      await delay(500)
      await js(`[...document.querySelectorAll(${JSON.stringify(`[data-file-block="${target}"] [data-testid="file-save"]`)})].pop()?.click()`)
      await delay(1500)
      files.updateStatusFull = await blockStatus()
      files.diskAfterSave = await readFile()
      await freshShot(win, path.join(outDir, 'smoke-chat-files.png'))
      await js(`[...document.querySelectorAll(${JSON.stringify(`[data-file-block="${target}"] [data-testid="file-undo"]`)})].pop()?.click()`)
      await delay(1500)
      files.statusAfterUndo = await blockStatus()
      files.diskAfterUndo = await readFile()
      report.chatFiles = files
      await setMode('limited')
    }
    // ----- WEB: the model searches, reads pages, downloads and installs a repository (real internet) -----
    const webModel = process.env.NETRUNNER_SMOKE_WEB_MODEL
    if (webModel) {
      const settingsBefore = await js<{ networkMode: string; webTools: string }>(`window.netrunner.invoke('settings:get')`)
      await js(`window.netrunner.invoke('settings:set-network-mode', 'online-tools')`)
      // FULL: the native confirmation dialogs cannot be clicked from here (they are checked by hand).
      await js(`window.netrunner.invoke('settings:set-web-tools', 'full')`)
      await js(`document.querySelector('[data-section="neural"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="chat-input"]')`, 20000)
      await js(`document.querySelector('[title="New session"]')?.click()`)
      await delay(500)
      // The toolbar reads the mode from the store; the NETWORK screen refreshes it. Then pick the model, WEB on.
      await js(`document.querySelector('[data-section="network"]').click()`)
      report.webToolsPanel = (await waitFor(`!!document.querySelector('[data-testid="web-tools"]')`, 15000))
        ? await js(`document.querySelector('[data-testid="web-tools"]').innerText.replace(/\\s+/g, ' ').slice(0, 300)`)
        : null
      await freshShot(win, path.join(outDir, 'smoke-web-tools.png'))
      await delay(800)
      await js(`document.querySelector('[data-section="neural"]').click()`)
      await waitFor(`!!document.querySelector('[data-testid="chat-web"] button:not([disabled])')`, 20000)
      await js(`(() => {
        const sel = document.querySelector('[data-testid="chat-model"]');
        const opt = [...sel.options].find(o => o.value.includes(${JSON.stringify(webModel)}));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await delay(500)
      await js(`document.querySelector('[data-testid="chat-web"] button').click()`)
      await delay(300)
      const askWeb = async (prompt: string, shot: string) => {
        const before = await js<number>(`document.querySelectorAll('[data-testid="chat-metrics"]').length`)
        // Only a new error line ends the wait (an earlier answer may already show one).
        const errors = `[...document.querySelectorAll('p.text-critical')].filter(p => /ERROR:/.test(p.innerText)).length`
        const errorsBefore = await js<number>(errors)
        await js(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(prompt)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await delay(300)
        const t0 = Date.now()
        await js(`document.querySelector('[data-testid="chat-send"]').click()`)
        await waitFor(`document.querySelectorAll('[data-testid="chat-metrics"]').length > ${before} || ${errors} > ${errorsBefore}`, 900000)
        // A send right after the reply would be refused while the stream closes; let it settle.
        await delay(1500)
        await freshShot(win, path.join(outDir, shot))
        return js<{ seconds: number; tools: { name: string; status: string; subject: string }[]; text: string }>(`(() => {
          const msgs = [...document.querySelectorAll('[data-role="assistant"]')];
          const last = msgs[msgs.length - 1];
          return {
            seconds: Math.round((Date.now() - ${t0}) / 1000),
            tools: [...last.querySelectorAll('[data-testid="tool-step"]')].map(s => ({ name: s.getAttribute('data-tool'), status: s.getAttribute('data-status'), subject: s.innerText.replace(/\\s+/g, ' ').slice(0, 160) })),
            text: last.innerText.slice(0, 2500),
          };
        })()`)
      }
      report.webSearch = await askWeb('What is the latest release tag of the llama.cpp project (ggml-org/llama.cpp on GitHub) right now? Look it up on the internet and tell me the tag and where you found it.', 'smoke-web-search.png')
      report.webFind = await askWeb('Search the internet for: SearXNG search API json format parameter. List the first three results you found with their URLs, then answer in one sentence how to get JSON results from SearXNG.', 'smoke-web-find.png')
      // Downloading and installing a third-party repository runs its code: only when asked for explicitly.
      if (process.env.NETRUNNER_SMOKE_WEB_REPO) report.webRepo = await askWeb('Download the repository https://github.com/sindresorhus/is-plain-obj , read its README and tell me in two sentences what it does, then install its dependencies and tell me whether the install succeeded.', 'smoke-web-repo.png')
      await js(`window.netrunner.invoke('settings:set-web-tools', ${JSON.stringify(settingsBefore.webTools)})`)
      await js(`window.netrunner.invoke('settings:set-network-mode', ${JSON.stringify(settingsBefore.networkMode)})`)
    }
    // ----- Autotuner: TUNE on a model card in MODEL VAULT, through the UI -----
    if (process.env.NETRUNNER_SMOKE_TUNE) {
      const model = process.env.NETRUNNER_SMOKE_TUNE
      await js(`document.querySelector('[data-section="models"]').click()`)
      const card = `document.querySelector('[data-autotune=' + CSS.escape(${JSON.stringify(model)}) + ']')`
      await waitFor(`!!${card}`, 30000)
      await js(`${card}.querySelector('[data-testid="autotune-run"]').click()`)
      const sawProgress = await waitFor(`/measuring|замер/.test(${card}.textContent)`, 60000)
      const done = await waitFor(`!!${card}.querySelector('[data-autotune-status]')`, 20 * 60_000)
      report.tune = { sawProgress, done, text: await js<string>(`${card}.textContent`), profile: await js(`window.netrunner.invoke('autotune:get', ${JSON.stringify(model)})`) }
      await freshShot(win, path.join(outDir, 'smoke-tune.png'))
    }
    // ----- Reverse interference: a model loaded, then busy threads on every logical CPU next to it -----
    if (process.env.NETRUNNER_SMOKE_RI) {
      const model = process.env.NETRUNNER_SMOKE_RI
      await js(`window.netrunner.invoke('models:load', ${JSON.stringify(model)})`)
      await delay(16000)
      const ri = { before: await js<unknown>(`window.netrunner.invoke('ri:get')`), badgeBefore: await js<string>(`document.querySelector('[data-testid="ri-badge"]')?.textContent ?? ''`), during: null as unknown, badgeDuring: '', widget: '', after: null as unknown }
      const hog = spawn(process.execPath, ['-e', "const { Worker } = require('node:worker_threads'); for (let i = 0; i < require('node:os').availableParallelism(); i++) new Worker('for(;;){}', { eval: true })"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      try {
        await delay(25000)
        ri.during = await js(`window.netrunner.invoke('ri:get')`)
        ri.badgeDuring = await js<string>(`document.querySelector('[data-testid="ri-badge"]')?.textContent ?? ''`)
        await js(`document.querySelector('[data-section="system"]').click()`)
        await delay(1500)
        ri.widget = await js<string>(`document.querySelector('[data-testid="widget-interference"]')?.textContent ?? ''`)
        await freshShot(win, path.join(outDir, 'smoke-ri.png'))
      } finally {
        hog.kill()
      }
      await delay(25000)
      ri.after = await js(`window.netrunner.invoke('ri:get')`)
      report.ri = ri
      await js(`window.netrunner.invoke('models:unload', ${JSON.stringify(model)})`)
    }
    // ----- Accessibility: axe-core (WCAG 2.1 A + AA) over every section -----
    if (process.env.NETRUNNER_SMOKE_A11Y) {
      // Bundled into this smoke chunk (only test builds have it), so the check also runs on a packaged test exe.
      await js((await import('axe-core/axe.min.js?raw')).default)
      const rules: Record<string, { impact: string; help: string; nodes: number; sections: string[]; sample: string }> = {}
      for (const section of ['workspace', 'editor', 'agents', 'neural', 'models', 'terminal', 'memory', 'git', 'system', 'forge', 'network']) {
        await js(`document.querySelector('[data-section="${section}"]').click()`)
        await delay(1500)
        const found = await js<{ id: string; impact: string; help: string; nodes: { target: string[]; html: string }[] }[]>(
          `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target, html: n.html.slice(0, 160) })) })))`,
        )
        for (const v of found) {
          const sample = (v.nodes[0]?.target ?? []).join(' ') + ' :: ' + (v.nodes[0]?.html ?? '')
          const r = (rules[v.id] ??= { impact: v.impact, help: v.help, nodes: 0, sections: [], sample: '' })
          r.nodes += v.nodes.length
          r.sections.push(section)
          r.sample += `[${section}] ${sample}\n`
        }
      }
      report.a11y = rules
    }
    // ----- FORGE screen (environment check; a real run only with NETRUNNER_SMOKE_FORGE=1) -----
    await js(`document.querySelector('[data-section="forge"]').click()`)
    report.forgeEnv = (await waitFor(`document.querySelectorAll('[data-forge-env]').length >= 7`, 15000))
      ? await js(`Object.fromEntries([...document.querySelectorAll('[data-forge-env]')].map(e => [e.getAttribute('data-forge-env'), e.getAttribute('data-ok') === 'true']))`)
      : null
    if (process.env.NETRUNNER_SMOKE_FORGE) {
      await js(`(() => {
        const set = (sel, v) => { const el = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
        set('[data-testid="forge-run"]', 'smoke-forge'); set('[data-testid="forge-chunks"]', '2'); set('[data-testid="forge-epochs"]', '1');
        for (const s of ['evaluate', 'bench']) { const c = document.querySelector('[data-forge-step="' + s + '"]'); if (c.checked) c.click() }
      })()`)
      await delay(300)
      await js(`document.querySelector('[data-testid="forge-start"]').click()`)
      const t0 = Date.now()
      report.forgeStarted = await waitFor(`!!document.querySelector('[data-testid="forge-cancel"]')`, 30000)
      report.forgeFinished = await waitFor(`!document.querySelector('[data-testid="forge-cancel"]')`, 60 * 60_000)
      report.forgeSeconds = Math.round((Date.now() - t0) / 1000)
      report.forgeState = await js(`window.netrunner.invoke('forge:state').then(s => ({ status: s.status, error: s.error, tail: s.log.slice(-6) }))`)
      report.forgeRun = await js(`window.netrunner.invoke('forge:runs').then(r => r.find(x => x.name === 'smoke-forge') ?? null)`)
      await freshShot(win, path.join(outDir, 'smoke-forge.png'))
    } else await freshShot(win, path.join(outDir, 'smoke-forge.png'))

    // ----- Russian interface -----
    await js(`document.querySelector('[data-testid="language-toggle"]').click()`)
    report.russianNav = (await waitFor(`document.querySelector('[data-section="agents"]').title === 'УПРАВЛЕНИЕ АГЕНТАМИ'`, 5000))
      ? await js(`[...document.querySelectorAll('[data-section]')].map(b => b.title)`)
      : null
    await js(`document.querySelector('[data-section="agents"]').click()`)
    await delay(800)
    report.russianAgents = await js(`document.body.innerText.includes('ДВИЖОК АГЕНТОВ') && document.body.innerText.includes('ОЧЕРЕДЬ ЗАДАЧ')`)
    await freshShot(win, path.join(outDir, 'smoke-russian.png'))
    await js(`document.querySelector('[data-testid="language-toggle"]').click()`)
    report.englishBack = await waitFor(`document.querySelector('[data-section="agents"]').title === 'AGENT CONTROL'`, 5000)
    report.ok = true
  } catch (err) {
    report.ok = false
    report.error = err instanceof Error ? err.stack : String(err)
  }
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(outDir, 'smoke-report.json'), JSON.stringify(report, null, 2))
  // The normal quit path (before-quit cleanup), as when the user closes the window; app.exit() would skip it.
  app.quit()
}
