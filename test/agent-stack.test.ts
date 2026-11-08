import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NetworkMode } from '../electron/shared/ipc'
import { outboundDecision } from '../electron/main/services/endpoint-policy'
import { GitService } from '../electron/main/services/git'
import { NetProxy } from '../electron/main/services/net-proxy'
import { buildOpencodeConfig, buildOpencodeEnv, freePort, mapPart, roleHeader, rolePolicyReply } from '../electron/main/services/opencode'

describe('outboundDecision', () => {
  it('applies the network mode per host without DNS', () => {
    expect(outboundDecision('127.0.0.1', 'strict-offline').allowed).toBe(true)
    expect(outboundDecision('localhost', 'strict-offline').allowed).toBe(true)
    expect(outboundDecision('models.dev', 'strict-offline').allowed).toBe(false)
    expect(outboundDecision('192.168.1.5', 'strict-offline').allowed).toBe(false)
    expect(outboundDecision('192.168.1.5', 'local-network').allowed).toBe(true)
    expect(outboundDecision('registry.npmjs.org', 'local-network').allowed).toBe(false)
    expect(outboundDecision('registry.npmjs.org', 'online-tools').allowed).toBe(true)
  })
})

describe('NetProxy', () => {
  let target: http.Server
  let targetPort = 0
  let mode: NetworkMode = 'strict-offline'
  const proxy = new NetProxy(() => mode)

  beforeAll(async () => {
    target = http.createServer((_req, res) => res.end('hello from target'))
    await new Promise<void>(r => target.listen(0, '127.0.0.1', () => r()))
    targetPort = (target.address() as AddressInfo).port
    await proxy.start('test')
  })
  afterAll(async () => {
    await proxy.stop()
    await new Promise(r => target.close(r))
  })

  const viaProxy = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port!, method: 'GET', path: url }, res => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })

  const connect = (hostPort: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port!, method: 'CONNECT', path: hostPort })
      req.on('connect', res => {
        resolve(res.statusCode ?? 0)
        res.socket.destroy()
      })
      req.on('response', res => resolve(res.statusCode ?? 0))
      req.on('error', reject)
      req.end()
    })

  it('forwards loopback requests and logs them', async () => {
    const r = await viaProxy(`http://127.0.0.1:${targetPort}/x`)
    expect(r).toEqual({ status: 200, body: 'hello from target' })
    expect(proxy.log.at(-1)).toMatchObject({ host: '127.0.0.1', allowed: true, source: 'test' })
  })

  it('blocks internet hosts in strict offline, both HTTP and CONNECT, without contacting them', async () => {
    mode = 'strict-offline'
    const r = await viaProxy('http://example.com/')
    expect(r.status).toBe(403)
    expect(r.body).toMatch(/STRICT-OFFLINE/)
    expect(await connect('models.dev:443')).toBe(403)
    expect(proxy.log.at(-1)).toMatchObject({ method: 'CONNECT', host: 'models.dev', port: 443, allowed: false })
  })

  it('exposes proxy variables for child processes', () => {
    const env = proxy.childEnv()
    expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${proxy.port}`)
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })
})

describe('freePort', () => {
  it('returns distinct, bindable loopback ports', async () => {
    const [a, b] = await Promise.all([freePort(), freePort()])
    expect(a).toBeGreaterThan(1024)
    expect(a).not.toBe(4096)
    const srv = http.createServer()
    await new Promise<void>(r => srv.listen(a, '127.0.0.1', () => r()))
    await new Promise(r => srv.close(r))
    expect(typeof b).toBe('number')
  })
})

describe('OpenCode config and env', () => {
  const backend = { baseURL: 'http://127.0.0.1:18301', apiKey: 'k123', label: 'Qwen3-Coder-Next-Q4_K_M', contextLength: 65536 }

  it('only contains the local llama-server provider and requires approvals', () => {
    const cfg = buildOpencodeConfig(backend, 'strict-offline') as Record<string, any>
    expect(Object.keys(cfg.provider)).toEqual(['llamacpp'])
    expect(cfg.provider.llamacpp.options).toEqual({ baseURL: 'http://127.0.0.1:18301/v1', apiKey: 'k123' })
    expect(cfg.provider.llamacpp.models['netrunner-agent']).toMatchObject({ name: 'Qwen3-Coder-Next-Q4_K_M', tools: true, limit: { context: 65536 } })
    expect(cfg.enabled_providers).toEqual(['llamacpp'])
    expect(cfg.model).toBe('llamacpp/netrunner-agent')
    expect(cfg.small_model).toBe('llamacpp/netrunner-agent')
    expect(cfg.autoupdate).toBe(false)
    expect(cfg.permission).toMatchObject({ edit: 'ask', bash: 'ask', webfetch: 'deny', external_directory: 'deny' })
    // Every role gets the same prompt and permissions (so the same tools): the shared prompt head is reused.
    expect(cfg.agent.architect.prompt).toBe(cfg.agent.debugger.prompt)
    expect(cfg.agent.architect.permission).toEqual(cfg.agent.debugger.permission)
    expect(cfg.agent.debugger.permission).toMatchObject({ edit: 'ask', bash: 'ask' })
    expect(buildOpencodeConfig(backend, 'online-tools').permission).toMatchObject({ webfetch: 'ask' })
  })

  it('keeps each role to its limits although every role is offered the same tools', () => {
    expect(roleHeader('architect').startsWith('[ROLE: ARCHITECT] You are ARCHITECT.')).toBe(true)
    for (const t of ['edit', 'write', 'patch', 'bash']) expect(rolePolicyReply('architect', t)).toBe('reject')
    expect(rolePolicyReply('reviewer', 'edit')).toBe('reject')
    expect(rolePolicyReply('reviewer', 'bash')).toBeNull()
    expect(rolePolicyReply('operator', 'write')).toBe('reject')
    expect(rolePolicyReply('coder', 'edit')).toBeNull()
    expect(rolePolicyReply('debugger', 'bash')).toBeNull()
    // A session of unknown role goes to the operator as before.
    expect(rolePolicyReply(undefined, 'edit')).toBeNull()
  })

  it('refuses any backend that is not on loopback', () => {
    expect(() => buildOpencodeConfig({ ...backend, baseURL: 'https://api.example.com' }, 'online-tools')).toThrow()
    expect(() => buildOpencodeConfig({ ...backend, baseURL: 'http://192.168.1.5:8080' }, 'local-network')).toThrow(/loopback/)
  })

  it('strips cloud credentials and isolates state', () => {
    const env = buildOpencodeEnv(
      { PATH: 'p', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', GITHUB_TOKEN: 'z', OPENCODE_CONFIG: '/evil.json', MY_SERVICE_API_KEY: 'k' },
      'D:\\data',
      { HTTPS_PROXY: 'http://127.0.0.1:1' },
    )
    expect(env.PATH).toBe('p')
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENCODE_CONFIG', 'MY_SERVICE_API_KEY']) expect(env[k]).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBe(path.join('D:\\data', 'config'))
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:1')
  })

  it('maps message parts', () => {
    expect(mapPart({ id: 'p', messageID: 'm', type: 'text', text: 'hi' }, 'user')).toEqual({ kind: 'text', id: 'p', messageId: 'm', role: 'user', text: 'hi' })
    expect(mapPart({ id: 'p', messageID: 'm', type: 'text', text: 'x', synthetic: true }, 'user')).toBeNull()
    // The role header goes to the model but not to the feed.
    expect(mapPart({ id: 'p', messageID: 'm', type: 'text', text: `${roleHeader('coder')}\n\nFix it` }, 'user')).toMatchObject({ text: 'Fix it' })
    expect(
      mapPart({ id: 't', messageID: 'm', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok', title: 'npm test' } }, 'assistant'),
    ).toMatchObject({ kind: 'tool', tool: 'bash', status: 'completed', output: 'ok', input: { command: 'npm test' } })
    expect(mapPart({ id: 's', messageID: 'm', type: 'step-start' }, 'assistant')).toBeNull()
  })
})

describe('GitService checkpoints', () => {
  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-git-'))
    git('init', '-q')
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
    await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.log\n')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'u\n') // untracked but not ignored: part of the snapshot
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reports non-repos', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-norepo-'))
    expect((await new GitService(() => tmp).status()).isRepo).toBe(false)
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('checkpoints, lists changes, shows versions and restores without touching index or HEAD', async () => {
    const svc = new GitService(() => dir)
    const headBefore = git('rev-parse', 'HEAD').trim()
    const statusBefore = git('status', '--porcelain')
    const cp = await svc.checkpoint('before agent')
    expect((await svc.checkpoints())[0]).toMatchObject({ commit: cp.commit, label: 'before agent' })
    expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git('status', '--porcelain')).toBe(statusBefore)

    // Simulated agent work: modify, add, delete, plus an ignored file that must survive a restore.
    await fs.writeFile(path.join(dir, 'a.txt'), 'two\n')
    await fs.writeFile(path.join(dir, 'new.txt'), 'n\n')
    await fs.rm(path.join(dir, 'untracked.txt'))
    await fs.writeFile(path.join(dir, 'ignored.log'), 'log\n')

    const changes = await svc.changes(cp.commit)
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'new.txt' },
      { status: 'D', path: 'untracked.txt' },
    ])
    expect(await svc.fileVersions(cp.commit, 'a.txt')).toEqual({ path: 'a.txt', original: 'one\n', modified: 'two\n' })

    await svc.restore(cp.commit)
    expect(await svc.changes(cp.commit)).toEqual([])
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await fs.readFile(path.join(dir, 'untracked.txt'), 'utf8')).toBe('u\n')
    await expect(fs.access(path.join(dir, 'new.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, 'ignored.log'), 'utf8')).toBe('log\n')
    expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore)
  })

  it('rejects unknown or malformed checkpoint ids', async () => {
    const svc = new GitService(() => dir)
    await expect(svc.changes('HEAD')).rejects.toThrow(/Invalid checkpoint/)
    await expect(svc.changes('0'.repeat(40))).rejects.toThrow(/Unknown checkpoint/)
    const cp = (await svc.checkpoints())[0]
    await expect(svc.fileVersions(cp.commit, '../outside.txt')).rejects.toThrow()
  })
})
