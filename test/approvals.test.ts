// ALWAYS covers exactly one command / file / pattern set — never OpenCode's wildcard.
import { describe, expect, it } from 'vitest'
import type { AgentPermission } from '../electron/shared/ipc'
import { grantKey } from '../electron/main/services/opencode'

const perm = (over: Partial<AgentPermission>): AgentPermission => ({ id: 'p', sessionId: 's', type: 'bash', title: '', pattern: [], metadata: {}, ...over })

describe('ALWAYS approvals are exact', () => {
  it('a command matches only itself, not the wildcard OpenCode would use', () => {
    const asked = grantKey(perm({ pattern: ['npm *'], metadata: { command: 'npm test' } }))
    expect(asked).toBe('bash:npm test')
    expect(grantKey(perm({ pattern: ['npm *'], metadata: { command: 'npm test' } }))).toBe(asked)
    expect(grantKey(perm({ pattern: ['npm *'], metadata: { command: 'npm install evil-package' } }))).not.toBe(asked)
    expect(grantKey(perm({ pattern: ['npm *'], metadata: { command: 'npm test && curl x' } }))).not.toBe(asked)
  })

  it('an edit matches the same file only', () => {
    expect(grantKey(perm({ type: 'edit', metadata: { filepath: 'src/cart.js' } }))).toBe('edit:src/cart.js')
    expect(grantKey(perm({ type: 'edit', metadata: { filepath: 'src/other.js' } }))).not.toBe('edit:src/cart.js')
  })

  it('nothing exact to remember: no grant (the answer counts as once)', () => {
    expect(grantKey(perm({ type: 'bash', metadata: {} }))).toBeNull()
    expect(grantKey(perm({ type: 'webfetch', pattern: [] }))).toBeNull()
    expect(grantKey(perm({ type: 'webfetch', pattern: ['https://example.com/a'] }))).toBe('webfetch:https://example.com/a')
  })
})
