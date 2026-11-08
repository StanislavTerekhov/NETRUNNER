// @vitest-environment happy-dom
// Agent approvals: the card shows the exact command, ALWAYS asks main for an exact grant, grants list and revoke.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentPermission } from '../../electron/shared/ipc'
import { ipc } from '../ui-setup'
import { Approvals } from '@/features/agents/AgentControl'
import { useAgent } from '@/app/agent-store'

const perm: AgentPermission = { id: 'per_1', sessionId: 'ses_1', type: 'bash', title: 'npm test', pattern: ['npm *'], metadata: { command: 'npm test' } }
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  ipc.reset()
  useAgent.setState({ permissions: [perm], grants: [], autoApproved: [], tasks: [] })
})
afterEach(cleanup)

describe('approvals', () => {
  it('shows the exact command and nothing runs before a click', () => {
    render(<Approvals />)
    expect(screen.getAllByText('npm test').length).toBeGreaterThan(0)
    expect(ipc.calls).toEqual([])
  })

  it('ALWAYS asks main for the grant and then shows it, with the exact command', async () => {
    ipc.answers.set('agent:grants', () => [{ key: 'bash:npm test', type: 'bash', what: 'npm test', uses: 0, since: '' }])
    render(<Approvals />)
    fireEvent.click(screen.getByText('ALWAYS'))
    await flush()
    await flush()
    expect(ipc.calls.map(c => c.channel)).toEqual(['agent:respond', 'agent:grants'])
    expect(ipc.calls[0].args).toEqual(['ses_1', 'per_1', 'always'])
    expect(document.querySelector('[data-grant="bash:npm test"]')?.textContent).toContain('npm test')
  })

  it('revoke removes the grant through main', async () => {
    useAgent.setState({ permissions: [], grants: [{ key: 'bash:npm test', type: 'bash', what: 'npm test', uses: 2, since: '' }] })
    ipc.answers.set('agent:revoke-grant', () => [])
    render(<Approvals />)
    expect(document.querySelector('[data-grant]')?.textContent).toContain('×2')
    fireEvent.click(screen.getByTitle('Revoke'))
    await flush()
    expect(ipc.calls.at(-1)).toEqual({ channel: 'agent:revoke-grant', args: ['bash:npm test'] })
    expect(document.querySelector('[data-grant]')).toBeNull()
  })
})
