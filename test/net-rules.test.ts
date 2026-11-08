// The operator's host rules (NETWORK → RULES) on top of the network mode, and the FIREWALL program list.
import { describe, expect, it } from 'vitest'
import { cleanHostRule, matchHost, outboundDecision } from '../electron/main/services/endpoint-policy'
import { FirewallService } from '../electron/main/services/firewall'
import { normalizeNetRules } from '../electron/main/services/settings'

const rules = { block: ['tracker.example.com', '*.ads.net', '203.0.113.9'], allow: ['github.com', 'registry.npmjs.org'], allowOnly: false }

describe('host rules', () => {
  it('matches a domain with its subdomains, "*." only subdomains, an IP only itself', () => {
    expect(matchHost('tracker.example.com', rules.block)).toBe('tracker.example.com')
    expect(matchHost('eu.tracker.example.com', rules.block)).toBe('tracker.example.com')
    expect(matchHost('example.com', rules.block)).toBeNull()
    expect(matchHost('x.ads.net', rules.block)).toBe('*.ads.net')
    expect(matchHost('ads.net', rules.block)).toBeNull()
    expect(matchHost('203.0.113.9', rules.block)).toBe('203.0.113.9')
    expect(matchHost('notgithub.com', ['github.com'])).toBeNull()
  })

  it('blocks a listed host in every mode, but never loopback', () => {
    expect(outboundDecision('tracker.example.com', 'online-tools', rules)).toEqual({ allowed: false, reason: 'blocked by your rule tracker.example.com' })
    expect(outboundDecision('example.org', 'online-tools', rules).allowed).toBe(true)
    expect(outboundDecision('127.0.0.1', 'online-tools', { ...rules, block: ['127.0.0.1'] }).allowed).toBe(true)
  })

  it('allow-only: ONLINE TOOLS reaches only the listed hosts; the LAN is not affected', () => {
    const strict = { ...rules, allowOnly: true }
    expect(outboundDecision('api.github.com', 'online-tools', strict).allowed).toBe(true)
    expect(outboundDecision('example.org', 'online-tools', strict)).toEqual({ allowed: false, reason: 'not in your allow list (allow-only is on)' })
    expect(outboundDecision('192.168.1.5', 'local-network', strict).allowed).toBe(true)
    // Without ONLINE TOOLS the internet stays closed whatever the allow list says.
    expect(outboundDecision('github.com', 'local-network', strict).allowed).toBe(false)
  })

  it('cleans what the operator types and drops junk', () => {
    expect(cleanHostRule(' https://GitHub.com/org/repo ')).toBe('github.com')
    expect(cleanHostRule('*.Example.org')).toBe('*.example.org')
    expect(cleanHostRule('not a host!')).toBeNull()
    expect(normalizeNetRules({ block: ['a.com', 'a.com', 'bad host'], allow: 'x', allowOnly: 'yes' })).toEqual({ block: ['a.com'], allow: [], allowOnly: false })
  })
})

describe('memory search mode setting', () => {
  it('defaults to embeddings, keeps an earlier reranker choice, ignores junk', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { SettingsStore } = await import('../electron/main/services/settings')
    const load = async (json: object) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-set-'))
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(json))
      const s = await new SettingsStore(dir).load()
      fs.rmSync(dir, { recursive: true, force: true })
      return s.memorySearch
    }
    expect(await load({})).toBe('vector')
    expect(await load({ memoryRerank: true })).toBe('rerank')
    expect(await load({ memoryRerank: false })).toBe('vector')
    expect(await load({ memorySearch: 'hybrid' })).toBe('hybrid')
    expect(await load({ memorySearch: 'nonsense' })).toBe('vector')
  })
})

describe('FIREWALL program list', () => {
  it("lists NETRUNNER's programs and the operator's own, with what is wanted and what is active", () => {
    const fw = new FirewallService({
      builtin: () => [{ path: 'C:\\NR\\opencode.exe', label: 'OpenCode' }],
      wanted: () => ({ blocked: ['c:\\nr\\OPENCODE.exe', 'C:\\Tools\\node.exe'], custom: ['C:\\Tools\\node.exe', 'C:\\NR\\opencode.exe'] }),
    })
    const list = fw.programs(['c:\\nr\\opencode.exe'])
    expect(list.map(p => [p.label, p.builtin, p.wanted, p.active])).toEqual([
      ['OpenCode', true, true, true],
      ['node.exe', false, true, false],
    ])
  })
})
