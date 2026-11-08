// Live: one real web search through the same code path as the chat and the agents. Opt-in: NETRUNNER_LIVE=1
import { describe, expect, it } from 'vitest'
import { WebTools } from '../electron/main/services/web-tools'

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('web search (live)', () => {
  it('DuckDuckGo answers with results', async () => {
    const log: string[] = []
    const tools = new WebTools({
      networkMode: () => 'online-tools',
      permission: () => 'limited',
      provider: () => 'duckduckgo',
      searxngUrl: () => null,
      secrets: () => ({ braveKey: null, googleKey: null, googleCx: null }),
      confirm: async () => false,
      log: (host, method, allowed, reason) => void log.push(`${allowed ? '+' : '-'} ${method} ${host} ${reason}`),
      reposDir: '.',
      childEnv: async () => ({}),
    })
    for (const query of ['llama.cpp latest release', 'ggml-org llama.cpp releases github']) {
      const out = await tools.run('web_search', { query })
      console.log(`[search] ${query}\n${out.slice(0, 600)}\n[log] ${log.splice(0).join(' | ')}`)
      expect(out).toMatch(/^Search results/)
    }
  }, 60_000)
})
