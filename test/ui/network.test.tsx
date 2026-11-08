// @vitest-environment happy-dom
// NETWORK panels: host rules, the firewall list, web tools settings — what each control sends to the main process.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FirewallStatus, Settings } from '../../electron/shared/ipc'
import { ipc } from '../ui-setup'
import { FirewallPanel, NetRulesPanel } from '@/features/network/FirewallPanels'
import { WebToolsPanel } from '@/features/network/WebToolsPanel'
import { useAi } from '@/app/ai-store'

const settings = (over: Partial<Settings> = {}) =>
  ({
    networkMode: 'online-tools',
    netRules: { block: ['tracker.example.com'], allow: [], allowOnly: false },
    webTools: 'limited',
    webSearch: { provider: 'duckduckgo', searxngUrl: null },
    webKeys: { brave: false, google: false },
    ...over,
  }) as Settings

const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  ipc.reset()
  useAi.setState({ settings: settings() })
})
afterEach(cleanup)

describe('RULES', () => {
  it('shows the stored rules and saves the edited list', async () => {
    ipc.answers.set('settings:set-net-rules', (r: unknown) => settings({ netRules: r as Settings['netRules'] }))
    render(<NetRulesPanel />)
    const block = screen.getByTestId('net-rules-block') as HTMLTextAreaElement
    expect(block.value).toBe('tracker.example.com')
    expect((screen.getByTestId('net-rules-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(block, { target: { value: 'tracker.example.com\n*.ads.net' } })
    fireEvent.click(screen.getByTestId('net-rules-save'))
    await flush()
    expect(ipc.calls.at(-1)).toEqual({ channel: 'settings:set-net-rules', args: [{ block: ['tracker.example.com', '*.ads.net'], allow: [], allowOnly: false }] })
  })
})

describe('FIREWALL', () => {
  const status = (pending: boolean): FirewallStatus => ({
    supported: true,
    pending,
    detail: 'No NETRUNNER rule',
    programs: [
      { path: 'C:\\NR\\opencode.exe', label: 'OpenCode (agent engine)', builtin: true, wanted: false, active: false, exists: true },
      { path: 'C:\\Tools\\node.exe', label: 'node.exe', builtin: false, wanted: true, active: false, exists: true },
    ],
  })

  it('lists programs; a tick asks main to change the wish only, nothing is applied without APPLY', async () => {
    ipc.answers.set('firewall:set-program', () => status(true))
    render(<FirewallPanel status={status(false)} onChange={() => undefined} />)
    expect(screen.getByText('OpenCode (agent engine)')).toBeTruthy()
    expect((screen.getByTestId('firewall-apply') as HTMLButtonElement).disabled).toBe(true)
    const row = [...document.querySelectorAll('[data-fw-program]')].find(r => r.getAttribute('data-fw-program') === 'C:\\NR\\opencode.exe')!
    fireEvent.click(row.querySelector('input')!)
    await flush()
    expect(ipc.calls.map(c => c.channel)).toEqual(['firewall:set-program'])
    expect(ipc.calls[0].args).toEqual(['C:\\NR\\opencode.exe', true])
  })

  it('APPLY is offered only when Windows differs from the wish', () => {
    render(<FirewallPanel status={status(true)} onChange={() => undefined} />)
    fireEvent.click(screen.getByTestId('firewall-apply'))
    expect(ipc.calls.at(-1)).toEqual({ channel: 'firewall:apply', args: ['sync'] })
  })
})

describe('WEB TOOLS', () => {
  it('a Brave key goes to main from a password field and is never shown back', async () => {
    useAi.setState({ settings: settings({ webSearch: { provider: 'brave', searxngUrl: null } }) })
    ipc.answers.set('settings:set-web-key', () => settings({ webSearch: { provider: 'brave', searxngUrl: null }, webKeys: { brave: true, google: false } }))
    const { container } = render(<WebToolsPanel />)
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'secret-key-123' } })
    fireEvent.click(screen.getByText('SAVE'))
    await flush()
    expect(ipc.calls.at(-1)).toEqual({ channel: 'settings:set-web-key', args: ['brave', 'secret-key-123'] })
    expect(container.textContent).not.toContain('secret-key-123')
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('')
  })

  it('switching the permission mode sends it to main', async () => {
    ipc.answers.set('settings:set-web-tools', (m: unknown) => settings({ webTools: m as Settings['webTools'] }))
    render(<WebToolsPanel />)
    fireEvent.change(screen.getByTestId('web-tools-mode'), { target: { value: 'ask' } })
    await flush()
    expect(ipc.calls.at(-1)).toEqual({ channel: 'settings:set-web-tools', args: ['ask'] })
  })
})
