// @vitest-environment happy-dom
// Chat answers in the UI: file blocks (path, SAVE / UNDO, excerpts), tool steps, and Markdown that never injects HTML.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Conversation } from '../../electron/shared/ipc'
import { ipc } from '../ui-setup'
import { MessageView } from '@/features/neural/MessageView'
import { Markdown } from '@/components/Markdown'
import { useChat } from '@/app/chat-store'
import { useStore } from '@/app/store'

type Msg = Conversation['messages'][number]

const answer = (content: string, extra: Partial<Msg> = {}): Msg => ({ role: 'assistant', content, ...extra })

function showAnswer(msg: Msg) {
  // The store holds the conversation SAVE / UNDO act on; the view shows its message 1.
  useChat.setState({
    current: { id: 'c1', title: 't', model: 'm', createdAt: '', updatedAt: '', systemPrompt: '', messages: [{ role: 'user', content: 'q' }, msg] },
    streamId: null,
  })
  return render(<MessageView message={msg} streaming={false} index={1} />)
}

beforeEach(() => {
  ipc.reset()
  useStore.setState({ workspace: { root: 'C:\\proj', name: 'proj' } as never })
})
afterEach(cleanup)

describe('file blocks in an answer', () => {
  it('shows the path and SAVE; SAVE sends exactly that block as a manual write', async () => {
    ipc.answers.set('chat:write-files', () => [{ path: 'src/a.ts', status: 'created', previous: null }])
    showAnswer(answer('Here:\n```ts path=src/a.ts\nexport const a = 1\n```'))
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    fireEvent.click(screen.getByTestId('file-save'))
    await new Promise(r => setTimeout(r, 0))
    const call = ipc.calls.find(c => c.channel === 'chat:write-files')
    expect(call?.args).toEqual([[{ path: 'src/a.ts', content: 'export const a = 1\n', partial: false }], 'manual'])
  })

  it('a written block offers UNDO instead of SAVE; an excerpt is marked', () => {
    showAnswer(
      answer('```ts path=src/a.ts\nconst a = 1\n```\n```ts path=src/b.ts\n// ... existing code\nconst b = 2\n```', {
        files: [{ path: 'src/a.ts', status: 'created', previous: null }],
      }),
    )
    const a = document.querySelector('[data-file-block="src/a.ts"]')!
    expect(a.getAttribute('data-file-status')).toBe('created')
    expect(a.querySelector('[data-testid="file-undo"]')).toBeTruthy()
    expect(a.querySelector('[data-testid="file-save"]')).toBeNull()
    const b = document.querySelector('[data-file-block="src/b.ts"]')!
    expect(b.textContent).toContain('EXCERPT')
  })

  it('without an open project there is nothing to save into', () => {
    useStore.setState({ workspace: null })
    showAnswer(answer('```ts path=src/a.ts\nconst a = 1\n```'))
    expect(screen.queryByTestId('file-save')).toBeNull()
  })
})

describe('tool steps', () => {
  it('lists each call with what it was about; a click shows what the tool returned', () => {
    showAnswer(
      answer('Done.', {
        tools: [
          { id: '1', name: 'web_search', args: '{"query":"llama.cpp release"}', status: 'done', result: '1. b12053' },
          { id: '2', name: 'fetch_url', args: '{"url":"https://github.com/x"}', status: 'error', result: 'Error: NO_INTERNET' },
        ],
      }),
    )
    const steps = document.querySelectorAll('[data-testid="tool-step"]')
    expect([...steps].map(s => [s.getAttribute('data-tool'), s.getAttribute('data-status')])).toEqual([
      ['web_search', 'done'],
      ['fetch_url', 'error'],
    ])
    expect(steps[0].textContent).toContain('llama.cpp release')
    expect(screen.queryByText('1. b12053')).toBeNull()
    fireEvent.click(steps[0].querySelector('button')!)
    expect(screen.getByText('1. b12053')).toBeTruthy()
  })
})

describe('Markdown from a model', () => {
  it('renders https links, never javascript: or raw HTML', () => {
    const { container } = render(<Markdown text={'[ok](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>'} />)
    const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(links).toEqual(['https://example.com'])
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
