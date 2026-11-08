// Phase 9: explorer file operations and disk watching, chat history search/export, ripgrep discovery,
// agent speed counters, FORGE commands, Markdown links/images, interface language setting.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isValidElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Database, vecExtensionPath } from '../electron/main/services/db'
import { ConversationStore } from '../electron/main/services/conversations'
import { forgeCommand, validateForgeRequest } from '../electron/main/services/forge'
import { counterDelta, parseServerCounters } from '../electron/main/services/llamacpp'
import { findRipgrep, pickRipgrepAsset, withPathFirst } from '../electron/main/services/ripgrep'
import { SettingsStore } from '../electron/main/services/settings'
import { validName, Workspace } from '../electron/main/services/workspace'
import { inline, safeImage, safeLink } from '../src/components/Markdown'
import type { Conversation } from '../electron/shared/ipc'

const VEC = vecExtensionPath(path.resolve(__dirname, '..'), null)
const temps: string[] = []
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('explorer file operations', () => {
  it('creates, renames and moves to the recycle bin inside the workspace only', async () => {
    const root = tmp('nr-ws-')
    const trashed: string[] = []
    const ws = new Workspace(async p => void trashed.push(p))
    await ws.open(root)
    expect(await ws.create('src', 'dir')).toMatchObject({ path: 'src', kind: 'dir' })
    expect(await ws.create('src/a.ts', 'file')).toMatchObject({ path: 'src/a.ts', kind: 'file' })
    await expect(ws.create('src/a.ts', 'file')).rejects.toThrow(/Already exists/)
    await expect(ws.create('../escape.txt', 'file')).rejects.toThrow(/escapes the workspace/)
    expect(await ws.rename('src/a.ts', 'src/b.ts')).toBe('src/b.ts')
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(true)
    await ws.create('src/c.ts', 'file')
    await expect(ws.rename('src/b.ts', 'src/c.ts')).rejects.toThrow(/Already exists/)
    await ws.remove('src/b.ts')
    expect(trashed).toEqual([path.join(root, 'src', 'b.ts')])
    await expect(ws.remove('')).rejects.toThrow(/root cannot be deleted/)
    ws.close()
  })

  it('rejects names Windows cannot store', () => {
    for (const bad of ['', '..', 'a/b', 'a\\b', 'con', 'NUL.txt', 'x:y', 'trailing.', 'q?']) expect(() => validName(bad), bad).toThrow()
    expect(validName(' main.py ')).toBe('main.py')
  })

  it('reports changes made on disk by others, ignoring node_modules and .git', async () => {
    const root = tmp('nr-watch-')
    fs.mkdirSync(path.join(root, 'node_modules'))
    const batches: string[][] = []
    const ws = new Workspace(undefined, paths => batches.push(paths))
    await ws.open(root)
    await new Promise(r => setTimeout(r, 200))
    fs.writeFileSync(path.join(root, 'agent.txt'), 'written by an agent')
    fs.writeFileSync(path.join(root, 'node_modules', 'noise.js'), '1')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !batches.flat().includes('agent.txt')) await new Promise(r => setTimeout(r, 50))
    ws.close()
    expect(batches.flat()).toContain('agent.txt')
    expect(batches.flat().some(p => p.startsWith('node_modules'))).toBe(false)
  })
})

describe('chat history', () => {
  const conv = (id: string, title: string, texts: string[]): Conversation => ({
    id,
    title,
    model: 'm.gguf',
    createdAt: '2026-10-31T10:00:00Z',
    updatedAt: `2026-10-31T10:0${id.length}:00Z`,
    systemPrompt: 'be brief',
    messages: texts.map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t })),
  })

  it('searches titles and messages in any script, case-insensitively', () => {
    const store = new ConversationStore(new Database(':memory:', VEC))
    store.save(conv('a', 'Корзина покупок', ['Почему скидка считается неверно?', 'Потому что цена не умножается на количество.']))
    store.save(conv('bb', 'Docker', ['How do I build the image?', 'Use docker build.']))
    expect(store.search('СКИДКА').map(c => c.id)).toEqual(['a'])
    expect(store.search('docker image').map(c => c.id)).toEqual(['bb'])
    expect(store.search('скидка docker')).toEqual([])
    expect(store.search('количество')[0].snippet).toContain('количество')
  })

  it('exports Markdown and JSON', () => {
    const store = new ConversationStore(new Database(':memory:', VEC))
    const c = conv('a', 'Корзина', ['вопрос', 'ответ'])
    c.messages[0].images = ['data:image/png;base64,AAAA']
    store.save(c)
    const md = store.export('a', 'md')
    expect(md).toContain('# Корзина')
    expect(md).toContain('## Operator')
    expect(md).toContain('_1 attached image(s)_')
    expect(md).toContain('## NEURAL CORE')
    expect(JSON.parse(store.export('a', 'json')).messages).toHaveLength(2)
  })
})

describe('ripgrep for the agents', () => {
  it('prefers NETRUNNER’s own copy, then PATH; picks the MSVC release asset; puts the folder first on PATH', () => {
    const own = tmp('nr-rg-')
    const onPath = tmp('nr-path-')
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
    expect(findRipgrep(own, onPath)).toBeNull()
    fs.writeFileSync(path.join(onPath, exe), '')
    expect(findRipgrep(own, onPath)).toBe(path.join(onPath, exe))
    fs.writeFileSync(path.join(own, exe), '')
    expect(findRipgrep(own, onPath)).toBe(path.join(own, exe))
    const assets = ['ripgrep-15.1.0-x86_64-pc-windows-gnu.zip', 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip', 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip.sha256'].map(name => ({ name, browser_download_url: '', size: 1 }))
    expect(pickRipgrepAsset(assets)?.name).toBe('ripgrep-15.1.0-x86_64-pc-windows-msvc.zip')
    expect(withPathFirst({ Path: 'C:\\Windows' }, 'C:\\rg')).toEqual({ Path: `C:\\rg${path.delimiter}C:\\Windows` })
  })
})

describe('agent speed from llama-server counters', () => {
  it('parses /metrics and turns two reads into a per-sequence speed', () => {
    const text = (n: number, s: number) =>
      `# HELP x\nllamacpp:prompt_tokens_total 100\nllamacpp:prompt_seconds_total 0.5\nllamacpp:tokens_predicted_total ${n}\nllamacpp:tokens_predicted_seconds_total ${s}\nllamacpp:predicted_tokens_seconds 78.6\n`
    const a = parseServerCounters(text(30, 0.4))!
    const b = parseServerCounters(text(230, 10.4))!
    expect(counterDelta(a, b)).toMatchObject({ outputTokens: 200, evalMs: 10000, tokensPerSecond: 20 })
    expect(parseServerCounters('llamacpp:tokens_predicted_total 1')).toBeNull()
  })
})

describe('FORGE from the UI', () => {
  it('builds each step command and validates the request', () => {
    const req = validateForgeRequest({ run: 'v3', steps: ['evaluate', 'dataset', 'train'], workspace: 'C:\\ws', maxChunks: 2, epochs: 1 })
    expect(req.steps).toEqual(['dataset', 'train', 'evaluate'])
    expect(forgeCommand('dataset', req, 'F')).toEqual([path.join('F', 'build_dataset.py'), '--workspace', 'C:\\ws', '--run', 'v3', '--max-chunks', '2'])
    expect(forgeCommand('train', req, 'F').slice(1)).toEqual(['--run', 'v3', '--epochs', '1'])
    expect(forgeCommand('evaluate', req, 'F').slice(1)).toEqual(['--run', 'v3', '--base', 'qwen3.5-4b-base', '--tuned', 'netrunner-v3'])
    expect(forgeCommand('bench', req, 'F')).toEqual([path.join('F', 'bench.py'), '--run', 'v3', '--models', 'qwen3.5-4b-base', 'netrunner-v3'])
    expect(() => validateForgeRequest({ run: '../x', steps: ['train'], workspace: '' })).toThrow(/Run name/)
    expect(() => validateForgeRequest({ run: 'ok', steps: [], workspace: '' })).toThrow(/at least one step/)
    expect(() => validateForgeRequest({ run: 'ok', steps: ['train'], workspace: '', epochs: 99 })).toThrow(/Invalid number/)
  })
})

describe('Markdown links and images', () => {
  const elements = (nodes: unknown[]) => nodes.filter(isValidElement) as ReactElement<{ href?: string; src?: string }>[]
  it('links https only and renders inline data images only', () => {
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a')
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('http://example.com')).toBeNull()
    expect(safeImage('data:image/png;base64,iVBORw0KGgo=')).not.toBeNull()
    expect(safeImage('https://example.com/x.png')).toBeNull()
    const nodes = inline('see [docs](https://example.com/docs), ![x](data:image/png;base64,AAAA) and [bad](javascript:alert(1)) or https://llama.cpp.org/x.')
    const els = elements(nodes)
    expect(els.map(e => e.props.href ?? e.props.src)).toEqual(['https://example.com/docs', 'data:image/png;base64,AAAA', 'https://llama.cpp.org/x'])
    expect(nodes).toContain('bad')
  })
})

describe('interface language', () => {
  it('defaults to the system language and keeps the user’s choice', async () => {
    const dir = tmp('nr-lang-')
    expect((await new SettingsStore(dir, () => 'ru').load()).language).toBe('ru')
    const s = new SettingsStore(dir, () => 'ru')
    await s.load()
    await s.setLanguage('en')
    expect((await new SettingsStore(dir, () => 'ru').load()).language).toBe('en')
    await expect(s.setLanguage('de' as 'en')).rejects.toThrow(/Unsupported/)
  })
})
