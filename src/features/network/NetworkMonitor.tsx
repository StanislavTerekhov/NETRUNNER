import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleSlash, Trash2 } from 'lucide-react'
import type { FirewallStatus, NetLogEntry } from '../../../electron/shared/ipc'
import { Panel, IconButton } from '@/components/hud/Panel'
import { NetworkPanel } from '@/features/models/ModelVault'
import { WebToolsPanel } from './WebToolsPanel'
import { FirewallPanel, NetRulesPanel } from './FirewallPanels'
import { formatBytes } from '@/lib/fit'
import { useAi } from '@/app/ai-store'
import { useStore } from '@/app/store'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/lib/i18n'

type Filter = 'all' | 'blocked' | 'allowed'

export function NetworkMonitor() {
  const [log, setLog] = useState<NetLogEntry[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [source, setSource] = useState<string>('all')
  const [fw, setFw] = useState<FirewallStatus | null>(null)
  const mode = useAi(s => s.settings?.networkMode)
  const notify = useStore(s => s.notify)
  const t = useT()

  useEffect(() => {
    void useAi.getState().refresh()
    void api.invoke('network:log').then(setLog)
    void api.invoke('firewall:status').then(setFw)
    return api.on('network:entry', e => setLog(l => [...l.slice(-999), e]))
  }, [])

  const sources = useMemo(() => [...new Set(log.map(e => e.source))].sort(), [log])
  const shown = log.filter(e => (filter === 'all' || (filter === 'blocked') !== e.allowed) && (source === 'all' || e.source === source)).slice(-400).reverse()
  const byHost = useMemo(() => {
    const m = new Map<string, { host: string; allowed: number; blocked: number; last: string }>()
    for (const e of log) {
      const k = `${e.host}:${e.port}`
      const r = m.get(k) ?? { host: k, allowed: 0, blocked: 0, last: e.time }
      if (e.allowed) r.allowed++
      else r.blocked++
      r.last = e.time
      m.set(k, r)
    }
    return [...m.values()].sort((a, b) => b.allowed + b.blocked - (a.allowed + a.blocked))
  }, [log])
  const blocked = log.filter(e => !e.allowed).length

  return (
    <div className="grid h-full grid-cols-[340px_minmax(0,1fr)] gap-2 p-2">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <NetworkPanel />
        <WebToolsPanel />
        <FirewallPanel status={fw} onChange={setFw} />
        <NetRulesPanel />
        <Panel title={t('ENFORCEMENT LAYERS')} fit accent="secondary">
          <ul data-testid="enforcement" className="flex flex-col gap-2 p-3 font-mono text-[11px]">
            <Layer ok label={t('Local model servers')} detail={t('llama-server runs on 127.0.0.1 only, with a fresh random API key per launch. No cloud provider exists in the code; the agent engine accepts only a loopback backend.')} />
            <Layer ok label={t('Renderer guard')} detail={t('Content-Security-Policy plus a request filter: the UI can load only its own bundle; every blocked attempt is logged.')} />
            <Layer ok label={t('Policy proxy (agent + terminal)')} detail={t('HTTP(S)_PROXY for OpenCode and the shell; mode {mode} applied per connection without DNS lookups.', { mode: mode?.toUpperCase() ?? '…' })} />
            <Layer ok={!!fw?.programs.some(p => p.active)} label={t('OS firewall (optional, FIREWALL below)')} detail={fw ? fw.detail : t('checking…')} />
          </ul>
          <p className="px-3 pb-3 text-[10.5px] text-dim">
            {t('Not covered: programs that ignore proxy settings, unless they are blocked in FIREWALL.')}
          </p>
        </Panel>
        <TrafficPanel />
        <Panel title={t('HOSTS')} fit>
          <ul className="flex flex-col p-2 font-mono text-[11px]">
            {byHost.length === 0 && <li className="p-1 text-dim">{t('No outbound attempts recorded.')}</li>}
            {byHost.slice(0, 30).map(h => (
              <li key={h.host} className="flex gap-2 px-1 py-0.5">
                <span className="truncate text-text">{h.host}</span>
                <span className="ml-auto text-success">{h.allowed || ''}</span>
                <span className="text-critical">{h.blocked ? `✕${h.blocked}` : ''}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        title={`${t('NETWORK ACTIVITY')} // ${t('{n} EVENTS', { n: log.length })} · ${t('{n} BLOCKED', { n: blocked })}`}
        actions={
          <IconButton
            title={t('Clear log')}
            onClick={() => {
              if (window.confirm(t('Clear the network activity log?'))) void api.invoke('network:clear').then(() => setLog([]))
            }}
          >
            <Trash2 size={12} />
          </IconButton>
        }
      >
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5 font-mono text-[10.5px]">
            {(['all', 'blocked', 'allowed'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)} className={`border px-2 py-0.5 ${filter === f ? 'border-primary text-primary' : 'border-line text-muted'}`}>
                {t(f.toUpperCase())}
              </button>
            ))}
            <select aria-label={t('Source')} value={source} onChange={e => setSource(e.target.value)} className="ml-2 border border-line bg-void px-1 py-0.5 text-text outline-none">
              <option value="all">{t('all sources')}</option>
              {sources.map(s => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table data-testid="network-log" className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 bg-surface text-left text-dim">
                <tr>
                  <th className="px-3 py-1 font-normal">{t('TIME')}</th>
                  <th className="px-2 py-1 font-normal">{t('SOURCE')}</th>
                  <th className="px-2 py-1 font-normal">{t('METHOD')}</th>
                  <th className="px-2 py-1 font-normal">{t('HOST')}</th>
                  <th className="px-2 py-1 font-normal">{t('DECISION')}</th>
                  <th className="px-2 py-1 font-normal">{t('REASON')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-3 text-dim">
                      {t('No matching events.')}
                    </td>
                  </tr>
                )}
                {shown.map(e => (
                  <tr key={e.id} data-net-allowed={e.allowed} className="border-t border-line/60">
                    <td className="px-3 py-0.5 text-dim">{new Date(e.time).toLocaleTimeString()}</td>
                    <td className="px-2 py-0.5 text-muted">{e.source}</td>
                    <td className="px-2 py-0.5 text-muted">{e.method}</td>
                    <td className="max-w-80 truncate px-2 py-0.5 text-text" title={`${e.host}:${e.port}`}>
                      {e.host}:{e.port}
                    </td>
                    <td className={`px-2 py-0.5 ${e.allowed ? 'text-success' : 'text-critical'}`}>{e.allowed ? 'ALLOW' : 'BLOCK'}</td>
                    <td className="px-2 py-0.5 text-dim">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </div>
  )
}

/** What NETRUNNER itself sent and received since it started, by source; refreshed every few seconds. */
function TrafficPanel() {
  const [rows, setRows] = useState<{ source: string; sent: number; received: number; connections: number }[]>([])
  const t = useT()
  useEffect(() => {
    const load = () => void api.invoke('network:traffic').then(setRows, () => undefined)
    load()
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [])
  const total = rows.reduce((n, r) => n + r.sent + r.received, 0)
  return (
    <Panel title={`${t('NETRUNNER TRAFFIC')} // ${formatBytes(total)}`} fit>
      <ul data-testid="netrunner-traffic" className="flex flex-col p-2 font-mono text-[11px]">
        {rows.length === 0 && <li className="p-1 text-dim">{t('Nothing sent or received since NETRUNNER started.')}</li>}
        {rows.map(r => (
          <li key={r.source} data-traffic={r.source} className="flex gap-2 px-1 py-0.5">
            <span className="text-text">{r.source}</span>
            <span className="ml-auto text-muted" title={t('sent')}>↑ {formatBytes(r.sent)}</span>
            <span className="text-muted" title={t('received')}>↓ {formatBytes(r.received)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Layer(props: { ok: boolean; label: string; detail: string; action?: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      {props.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" /> : <CircleSlash size={14} className="mt-0.5 shrink-0 text-dim" />}
      <div className="flex flex-col">
        <span className={props.ok ? 'text-text' : 'text-muted'}>{props.label}</span>
        <span className="text-[10.5px] text-dim">{props.detail}</span>
        {props.action}
      </div>
    </li>
  )
}
