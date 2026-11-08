import net from 'node:net'
import type { NetRules, NetworkMode } from '../../shared/ipc'

export class EndpointPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EndpointPolicyError'
  }
}

export function isLoopback(host: string): boolean {
  if (host === 'localhost') return true
  if (net.isIPv4(host)) return host.startsWith('127.')
  if (net.isIPv6(host)) return host === '::1'
  return false
}

export function isPrivateLan(host: string): boolean {
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (net.isIPv6(host)) {
    const h = host.toLowerCase()
    return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
  }
  // Hostnames could resolve anywhere; only .local mDNS names are accepted as LAN.
  return host.endsWith('.local')
}

/**
 * Inference endpoints must be local. Loopback is always allowed; private LAN addresses only
 * outside strict-offline mode. Public hosts are never allowed, in any mode.
 */
export function assertInferenceEndpoint(rawUrl: string, mode: NetworkMode): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new EndpointPolicyError(`Invalid runtime URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EndpointPolicyError(`Unsupported protocol: ${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isLoopback(host)) return url
  if (isPrivateLan(host)) {
    if (mode === 'strict-offline') throw new EndpointPolicyError(`LAN runtime ${host} is blocked in STRICT OFFLINE mode`)
    return url
  }
  throw new EndpointPolicyError(`Remote inference endpoints are prohibited: ${host}`)
}

/**
 * Outbound policy for tool processes (OpenCode, agent commands) going through the NETRUNNER proxy.
 * Host names are classified without DNS lookups, so a blocked name never even resolves.
 */
export function outboundDecision(host: string, mode: NetworkMode, rules?: NetRules): { allowed: boolean; reason: string } {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopback(h)) return { allowed: true, reason: 'loopback' }
  // The operator's own rules come before the mode: a blocked name stays blocked in every mode.
  const blockedBy = rules && matchHost(h, rules.block)
  if (blockedBy) return { allowed: false, reason: `blocked by your rule ${blockedBy}` }
  if (isPrivateLan(h)) {
    return mode === 'strict-offline'
      ? { allowed: false, reason: 'LAN blocked in STRICT OFFLINE' }
      : { allowed: true, reason: 'private LAN' }
  }
  if (mode !== 'online-tools') return { allowed: false, reason: `internet blocked in ${mode.toUpperCase()}` }
  if (rules?.allowOnly) {
    const allowedBy = matchHost(h, rules.allow)
    return allowedBy ? { allowed: true, reason: `ONLINE TOOLS, allowed by your rule ${allowedBy}` } : { allowed: false, reason: 'not in your allow list (allow-only is on)' }
  }
  return { allowed: true, reason: 'ONLINE TOOLS' }
}

/**
 * The first rule that covers a host: "example.com" covers it and its subdomains, "*.example.com" only the
 * subdomains, an IP address only itself.
 */
export function matchHost(host: string, patterns: string[]): string | null {
  const h = host.toLowerCase().replace(/\.$/, '')
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase().replace(/\.$/, '')
    if (!p) continue
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1))) return raw.trim()
    } else if (h === p || h.endsWith(`.${p}`)) return raw.trim()
  }
  return null
}

/** A host rule as typed by the operator: a domain, "*.domain" or an IP address; anything else is dropped. */
export function cleanHostRule(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) || /^[0-9a-f:.]+$/.test(s) ? s.slice(0, 253) : null
}

/** Actions that make the runtime reach the internet (model downloads) need ONLINE TOOLS mode. */
export function assertOnlineAllowed(mode: NetworkMode, action: string): void {
  if (mode !== 'online-tools') {
    throw new EndpointPolicyError(`${action} needs ONLINE TOOLS network mode (current: ${mode.toUpperCase()})`)
  }
}
