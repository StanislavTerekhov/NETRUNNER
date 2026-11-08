import { useState } from 'react'
import type { ChatFileWrites, WebSearchProvider } from '../../../electron/shared/ipc'
import { Panel } from '@/components/hud/Panel'
import { useAi } from '@/app/ai-store'
import { useStore } from '@/app/store'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/lib/i18n'

/**
 * WEB TOOLS: what the chat (WEB toggle) and the agents may do on the internet without asking, and which search
 * provider they use. API keys go to the main process and are stored encrypted; the UI only learns that one is set.
 */
export function WebToolsPanel() {
  const settings = useAi(s => s.settings)
  const notify = useStore(s => s.notify)
  const t = useT()
  const [searx, setSearx] = useState<string | null>(null)
  const [brave, setBrave] = useState('')
  const [gKey, setGKey] = useState('')
  const [gCx, setGCx] = useState('')
  if (!settings) return null
  const web = settings.webSearch

  const apply = async (call: () => Promise<typeof settings>) => {
    try {
      useAi.setState({ settings: await call() })
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const setProvider = (provider: WebSearchProvider, url = web.searxngUrl) => apply(() => api.invoke('settings:set-web-search', provider, url))
  const field = 'border border-line bg-void px-1 py-0.5 text-text outline-none'

  return (
    <Panel title="WEB TOOLS" fit>
      <div data-testid="web-tools" className="flex flex-col gap-2 p-3 font-mono text-[11px] text-muted">
        <p className="text-[10.5px] text-dim">
          {t('Search, reading pages and downloading / installing / running repositories for the chat (WEB) and the agents. Works only in ONLINE TOOLS; every request is in the network log.')}
        </p>
        <label className="flex items-center gap-2">
          {t('PERMISSION')}
          <select data-testid="web-tools-mode" value={settings.webTools} onChange={e => void apply(() => api.invoke('settings:set-web-tools', e.target.value as ChatFileWrites))} className={field}>
            <option value="ask">{t('ASK')}</option>
            <option value="limited">{t('LIMITED')}</option>
            <option value="full">{t('FULL')}</option>
          </select>
        </label>
        <p className="text-[10.5px] text-dim">
          {settings.webTools === 'ask'
            ? t('Every search, page, download, install and command is confirmed.')
            : settings.webTools === 'limited'
              ? t('Search and reading pages without questions; download, install and commands are confirmed.')
              : t('Nothing is confirmed. Installing a repository runs its scripts with your user rights.')}
        </p>
        <label className="flex items-center gap-2">
          {t('SEARCH')}
          <select data-testid="web-search-provider" value={web.provider} onChange={e => void setProvider(e.target.value as WebSearchProvider)} className={field}>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="searxng">SearXNG</option>
            <option value="brave">Brave Search API{settings.webKeys.brave ? '' : ` (${t('no key')})`}</option>
            <option value="google">Google Custom Search{settings.webKeys.google ? '' : ` (${t('no key')})`}</option>
          </select>
        </label>
        <p className="text-[10.5px] text-dim">{t('DuckDuckGo needs no key and is the fallback when another provider fails.')}</p>
        {web.provider === 'searxng' && (
          <div className="flex items-center gap-1">
            <input
              value={searx ?? web.searxngUrl ?? ''}
              onChange={e => setSearx(e.target.value)}
              placeholder="http://127.0.0.1:8888"
              className={`${field} min-w-0 flex-1`}
            />
            <button onClick={() => void setProvider('searxng', (searx ?? web.searxngUrl ?? '').trim() || null)} className="border border-secondary px-2 py-0.5 text-secondary">
              {t('SAVE')}
            </button>
          </div>
        )}
        {web.provider === 'brave' && (
          <KeyRow
            label={settings.webKeys.brave ? t('Brave key stored (encrypted)') : t('Brave Search API key')}
            stored={settings.webKeys.brave}
            onSave={() => apply(() => api.invoke('settings:set-web-key', 'brave', brave)).then(() => setBrave(''))}
            onClear={() => apply(() => api.invoke('settings:set-web-key', 'brave', null))}
          >
            <input type="password" value={brave} onChange={e => setBrave(e.target.value)} autoComplete="off" className={`${field} min-w-0 flex-1`} />
          </KeyRow>
        )}
        {web.provider === 'google' && (
          <KeyRow
            label={settings.webKeys.google ? t('Google key stored (encrypted)') : t('Google API key and search engine id (cx); new keys are no longer issued by Google')}
            stored={settings.webKeys.google}
            onSave={() => apply(() => api.invoke('settings:set-web-key', 'google', gKey, gCx)).then(() => (setGKey(''), setGCx('')))}
            onClear={() => apply(() => api.invoke('settings:set-web-key', 'google', null))}
          >
            <input type="password" value={gKey} onChange={e => setGKey(e.target.value)} placeholder="key" autoComplete="off" className={`${field} min-w-0 flex-1`} />
            <input value={gCx} onChange={e => setGCx(e.target.value)} placeholder="cx" autoComplete="off" className={`${field} w-24`} />
          </KeyRow>
        )}
      </div>
    </Panel>
  )
}

function KeyRow(props: { label: string; stored: boolean; onSave: () => void; onClear: () => void; children: React.ReactNode }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      <span className={props.stored ? 'text-success' : ''}>{props.label}</span>
      <div className="flex items-center gap-1">
        {props.children}
        <button onClick={props.onSave} className="border border-secondary px-2 py-0.5 text-secondary">
          {t('SAVE')}
        </button>
        {props.stored && (
          <button onClick={props.onClear} className="border border-critical px-2 py-0.5 text-critical">
            {t('REMOVE')}
          </button>
        )}
      </div>
    </div>
  )
}
