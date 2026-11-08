// Component tests (test/ui/*.test.tsx, happy-dom): a fake window.netrunner bridge that records every IPC call and
// answers from a per-test table. Loaded before any renderer module, which reads window.netrunner at import time.
import { vi } from 'vitest'

export const ipc = {
  calls: [] as { channel: string; args: unknown[] }[],
  answers: new Map<string, (...args: unknown[]) => unknown>(),
  reset() {
    this.calls.length = 0
    this.answers.clear()
  },
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { netrunner: unknown }).netrunner = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      ipc.calls.push({ channel, args })
      const answer = ipc.answers.get(channel)
      return answer ? answer(...args) : undefined
    }),
    on: vi.fn(() => () => undefined),
    platform: 'win32',
  }
}
