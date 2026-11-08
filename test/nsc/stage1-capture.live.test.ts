// NSC stage 1, check 2: what OpenCode actually sends the model for each agent role, and how long the part shared by
// all roles is. OpenCode talks to a stand-in server that records each request and answers "OK" — no model, no GPU.
//   NETRUNNER_LIVE=1 npx vitest run test/nsc/stage1-capture.live.test.ts --silent=false
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRole } from '../../electron/shared/ipc'
import { NetProxy } from '../../electron/main/services/net-proxy'
import { OpenCodeService } from '../../electron/main/services/opencode'

const root = path.resolve(import.meta.dirname, '..', '..')
const outDir = path.join(os.homedir(), 'NETRUNNER', 'nsc', 'stage1')
const ROLES: AgentRole[] = ['architect', 'coder', 'debugger', 'reviewer', 'operator']

type Body = { messages: { role: string; content: unknown }[]; tools?: unknown[]; stream?: boolean }

/** The prompt as the chat template lays it out: system text, then the tool definitions, then the conversation. */
export function flatten(b: Body): string {
  const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c))
  const [sys, rest] = [b.messages.filter(m => m.role === 'system'), b.messages.filter(m => m.role !== 'system')]
  return [...sys.map(m => text(m.content)), JSON.stringify(b.tools ?? []), ...rest.map(m => `${m.role}: ${text(m.content)}`)].join('\n')
}

const lcp = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function standIn(captured: Body[]): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => (raw += d))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) return void res.writeHead(404).end()
      const body = JSON.parse(raw) as Body
      captured.push(body)
      const id = `c${captured.length}`
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ id, object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.write(chunk({ role: 'assistant', content: 'OK' }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 1: agent prompts per role', () => {
  it('captures the first request of every role and measures the shared prefix', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const captured: Body[] = []
    const server = await standIn(captured)
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netrunner-capture-'))
    fs.cpSync(path.join(root, 'test', 'fixtures', 'agent-sample'), work, { recursive: true })
    const proxy = new NetProxy(() => 'strict-offline')
    const idle = new Map<string, () => void>()
    const agent = new OpenCodeService({
      binary: path.join(root, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
      dataDir: path.join(work, '..', `${path.basename(work)}-opencode`),
      acquireModel: async () => ({ baseURL: url, apiKey: 'k', label: 'stand-in', contextLength: 65536 }),
      releaseModel: () => undefined,
      getMode: () => 'strict-offline',
      proxyEnv: async () => {
        await proxy.start('agent')
        return proxy.childEnv()
      },
      emit: ev => {
        if (ev.type === 'status' && !ev.busy) idle.get(ev.sessionId)?.()
      },
    })
    const firstOf: Record<string, Body> = {}
    try {
      await agent.start(work, 'stand-in')
      for (const role of ROLES) {
        const session = await agent.createSession(`capture ${role}`)
        const before = captured.length
        const done = new Promise<void>(r => idle.set(session.id, r))
        await agent.prompt({ sessionId: session.id, role, text: 'Добавь проверку на пустую корзину в src/cart.js.' })
        await Promise.race([done, new Promise(r => setTimeout(r, 60_000))])
        // The main request carries the tools; title generation and other side requests do not.
        const main = captured.slice(before).find(b => b.tools?.length)
        if (main) firstOf[role] = main
      }
    } finally {
      await agent.stop()
      await proxy.stop()
      server.close()
    }
    const flat = Object.fromEntries(Object.entries(firstOf).map(([r, b]) => [r, flatten(b)]))
    const report: Record<string, unknown> = {}
    for (const r of Object.keys(flat)) {
      const b = firstOf[r]
      const sys = b.messages.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
      report[r] = {
        chars: flat[r].length,
        systemChars: sys.length,
        toolsChars: JSON.stringify(b.tools ?? []).length,
        tools: (b.tools as { function?: { name?: string } }[]).map(t => t.function?.name),
        systemHead: sys.slice(0, 300),
        sharedWithOthers: Object.fromEntries(Object.keys(flat).filter(o => o !== r).map(o => [o, lcp(flat[r], flat[o])])),
      }
    }
    report.sideRequests = captured.filter(b => !b.tools?.length).map(b => flatten(b).slice(0, 200))
    fs.writeFileSync(path.join(outDir, 'captured-requests.json'), JSON.stringify(captured, null, 1))
    fs.writeFileSync(path.join(outDir, 'role-prefixes.json'), JSON.stringify(report, null, 2))
    for (const r of Object.keys(flat)) {
      const x = report[r] as { chars: number; systemChars: number; toolsChars: number; sharedWithOthers: Record<string, number> }
      console.log(`[capture] ${r}: ${x.chars} chars (system ${x.systemChars}, tools ${x.toolsChars}); shared prefix: ${JSON.stringify(x.sharedWithOthers)}`)
    }
    expect(Object.keys(firstOf)).toHaveLength(ROLES.length)
  }, 10 * 60_000)
})
