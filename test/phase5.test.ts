import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../electron/main/services/db'
import { encodePowerShell, firewallSyncCommand, ruleName, RULE_PREFIX } from '../electron/main/services/firewall'
import { MetricsStore, NetLog } from '../electron/main/services/metrics'
import { cpuUsage, parseGpuSamples } from '../electron/main/services/telemetry'
import { evaluateSetup } from '../electron/main/services/setup'
import { inline, parseMarkdown } from '../src/components/Markdown'

const VEC = path.resolve(import.meta.dirname, '..', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')

const cpu = (user: number, idle: number): os.CpuInfo => ({ model: 'x', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } })

describe('telemetry parsing', () => {
  it('computes CPU usage from os.cpus deltas', () => {
    const u = cpuUsage([cpu(100, 900), cpu(0, 1000)], [cpu(150, 950), cpu(100, 1000)])
    expect(u.cores).toEqual([50, 100])
    expect(u.overall).toBeCloseTo(75)
    expect(cpuUsage([], [cpu(1, 1)]).overall).toBe(0)
  })

  it('parses nvidia-smi rows and keeps unsupported fields null', () => {
    const [g] = parseGpuSamples('NVIDIA GeForce RTX 3060, 37, 9216, 12288, 61, 97.45, 170.00, 1807\n')
    expect(g).toEqual({
      name: 'NVIDIA GeForce RTX 3060',
      utilizationPct: 37,
      vramUsedBytes: 9216 * 1024 * 1024,
      vramTotalBytes: 12288 * 1024 * 1024,
      temperatureC: 61,
      powerW: 97.45,
      powerLimitW: 170,
      clockMhz: 1807,
    })
    expect(parseGpuSamples('X, [N/A], 1, 2, [N/A], [N/A], [N/A], [N/A]')[0]).toMatchObject({ utilizationPct: null, temperatureC: null, powerW: null })
  })
})

describe('MetricsStore', () => {
  it('records measured chat runs and aggregates per model', () => {
    const m = new MetricsStore(new Database(':memory:', VEC))
    const run = (tps: number, out = 100) => ({ promptTokens: 50, outputTokens: out, promptMs: 100, evalMs: 1000, loadMs: 2000, totalMs: 3100, tokensPerSecond: tps })
    m.recordChat('qwen3:8b', run(50))
    m.recordChat('qwen3:8b', run(60))
    m.recordChat('qwen3.6:35b', run(14))
    m.recordChat('qwen3:8b', run(0, 0)) // no tokens: not a measurement
    const { recent, perModel } = m.inference(10)
    expect(recent).toHaveLength(3)
    expect(perModel[0]).toMatchObject({ model: 'qwen3:8b', runs: 2, avgTokensPerSecond: 55, bestTokensPerSecond: 60, avgPromptTokensPerSecond: 500, avgLoadMs: 2000 })
    expect(perModel[1].model).toBe('qwen3.6:35b')
  })

  it('aggregates agent task durations by role', () => {
    const store = new Database(':memory:', VEC)
    const ins = store.db.prepare(`INSERT INTO tasks (workspace, role, prompt, status, created_at, started_at, finished_at) VALUES ('w', ?, 'p', ?, 't', ?, ?)`)
    ins.run('coder', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:40Z')
    ins.run('coder', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')
    ins.run('reviewer', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z')
    const perf = new MetricsStore(store).tasks()
    expect(perf.find(p => p.role === 'coder')).toMatchObject({ runs: 2, done: 1, failed: 1 })
    expect(perf.find(p => p.role === 'coder')!.avgSeconds).toBeCloseTo(50, 0)
  })
})

describe('NetLog', () => {
  it('persists entries in order and clears', () => {
    const seen: number[] = []
    const log = new NetLog(new Database(':memory:', VEC), e => seen.push(e.id))
    log.record({ time: '1', source: 'agent', method: 'CONNECT', host: 'models.dev', port: 443, allowed: false, reason: 'x' })
    log.record({ time: '2', source: 'renderer', method: 'GET', host: 'cdn.example', port: 443, allowed: false, reason: 'y' })
    expect(log.list().map(e => e.host)).toEqual(['models.dev', 'cdn.example'])
    expect(log.list()[0].allowed).toBe(false)
    expect(seen).toEqual([1, 2])
    log.clear()
    expect(log.list()).toEqual([])
  })
})

describe('firewall command', () => {
  it('replaces only NETRUNNER rules with one outbound Internet block per wanted program', () => {
    const oc = "C:\\Program Files\\NETRUNNER\\resources\\opencode\\opencode.exe"
    const cmd = firewallSyncCommand([oc, 'C:\\tools\\node.exe'])
    expect(cmd).toContain(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*'`)
    expect(cmd).toContain(`-DisplayName '${ruleName(oc)}'`)
    expect(cmd).toContain('-Direction Outbound')
    expect(cmd).toContain('-RemoteAddress Internet')
    expect(cmd).toContain('-Action Block')
    expect(cmd).toContain(`-Program '${oc}'`)
    expect(cmd.match(/New-NetFirewallRule/g)).toHaveLength(2)
    expect(cmd.indexOf('Remove-NetFirewallRule')).toBeLessThan(cmd.indexOf('New-NetFirewallRule'))
    expect(firewallSyncCommand([])).not.toContain('New-NetFirewallRule')
    // Two programs with the same file name get different rules.
    expect(ruleName('C:\\a\\node.exe')).not.toBe(ruleName('C:\\b\\node.exe'))
  })
  it('escapes quotes in paths and encodes as UTF-16LE base64', () => {
    expect(firewallSyncCommand(["C:\\it's\\o.exe"])).toContain("'C:\\it''s\\o.exe'")
    expect(Buffer.from(encodePowerShell('Get-Date'), 'base64').toString('utf16le')).toBe('Get-Date')
  })
})

describe('evaluateSetup', () => {
  const status = { backend: 'llama.cpp' as const, url: 'C:\\rt\\b12020', reachable: true, version: 'b12020', error: null }
  const e = (id: string, name: string, caps: string[], kind: 'chat' | 'embedding' = 'chat') => ({
    id, source: 'netrunner' as const, name, files: [id], sizeBytes: 1, modifiedAt: '', kind, arch: null, sizeLabel: null, quant: null, contextLength: null, expertCount: null, mmproj: null, capabilities: caps, license: null, mtp: false, blocks: null,
  })
  const catalog = [e('g.gguf', 'Qwen3.8-27B', ['completion', 'tools']), e('c.gguf', 'Qwen3-Coder-Next', ['completion', 'tools']), e('m.gguf', 'Qwen3-Embedding', ['embedding'], 'embedding')]
  const base = { status, catalog, roles: { general: 'g.gguf', agent: 'c.gguf', embedding: 'm.gguf', reranker: 'r.gguf' }, opencodeBinary: true, git: 'git version 2.45', gpu: 'RTX 3060', ripgrep: 'C:\\rg\\rg.exe' }

  it('reports a fully provisioned machine as ready', () => {
    expect(evaluateSetup(base).every(i => i.ok)).toBe(true)
  })

  it('offers Hugging Face downloads for missing roles and the runtime install', () => {
    const empty = evaluateSetup({ ...base, catalog: [], roles: { general: null, agent: null, embedding: null }, status: { ...status, reachable: false, version: null, error: 'llama.cpp runtime is not installed' } })
    expect(empty.find(i => i.id === 'runtime')).toMatchObject({ ok: false, required: true, fix: { kind: 'install-runtime' } })
    expect(empty.find(i => i.id === 'general-model')?.fix).toEqual({ kind: 'pull', model: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M' })
    expect(empty.find(i => i.id === 'agent-model')?.fix).toEqual({ kind: 'pull', model: 'Qwen/Qwen3-Coder-Next-GGUF:Q4_K_M' })
    expect(empty.find(i => i.id === 'embedding-model')?.fix).toEqual({ kind: 'pull', model: 'Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0' })
  })

  it('flags missing required pieces', () => {
    const noBinary = evaluateSetup({ ...base, opencodeBinary: false, git: null })
    expect(noBinary.find(i => i.id === 'opencode')).toMatchObject({ ok: false, required: true })
    expect(noBinary.find(i => i.id === 'git')).toMatchObject({ ok: false, required: false })
  })

  it('offers the ripgrep install when no rg is found', () => {
    expect(evaluateSetup({ ...base, ripgrep: null }).find(i => i.id === 'ripgrep')).toMatchObject({ ok: false, required: false, fix: { kind: 'install-ripgrep' } })
  })
})

describe('Markdown parser', () => {
  it('parses the block types models produce', () => {
    const md = '## Result\n\nAll **3** tests pass.\n\n| # | Test |\n|---|---|\n| 1 | sums |\n\n- one\n- two\n\n```js\nx = 1\n```\n---\n> note'
    expect(parseMarkdown(md).map(b => b.kind)).toEqual(['heading', 'para', 'table', 'list', 'code', 'rule', 'quote'])
    const table = parseMarkdown(md)[2]
    expect(table).toEqual({ kind: 'table', header: ['#', 'Test'], rows: [['1', 'sums']] })
  })
  it('keeps an unterminated fence while streaming and never loops', () => {
    expect(parseMarkdown('```ts\nconst a = 1')).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = 1', path: null }])
    expect(parseMarkdown('|not a table').map(b => b.kind)).toEqual(['para'])
  })
  it('turns markup-looking text into plain strings, not HTML', () => {
    const nodes = inline('<img src=x onerror=alert(1)> and `<b>`')
    expect(nodes[0]).toBe('<img src=x onerror=alert(1)> and ')
    expect(typeof nodes[0]).toBe('string')
  })
})
