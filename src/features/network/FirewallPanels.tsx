import { useEffect, useState } from 'react'
import { Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import type { FirewallStatus, NetRules } from '../../../electron/shared/ipc'
import { Panel } from '@/components/hud/Panel'
import { useAi } from '@/app/ai-store'
import { useStore } from '@/app/store'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/lib/i18n'

/**
 * FIREWALL: which programs Windows Firewall keeps off the internet. NETRUNNER's own programs are listed; the operator
 * adds any other .exe and ticks what to block. Nothing changes in Windows until APPLY (confirmed, then UAC).
 */
export function FirewallPanel({ status, onChange }: { status: FirewallStatus | null; onChange: (s: FirewallStatus) => void }) {
  const notify = useStore(s => s.notify)
  const t = useT()
  const [busy, setBusy] = useState(false)
  const act = async (call: () => Promise<FirewallStatus>) => {
    setBusy(true)
    try {
      onChange(await call())
    } catch (err) {
      if (!errorMessage(err).includes('cancelled')) notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  if (!status) return null
  const anyActive = status.programs.some(p => p.active)
  return (
    <Panel title={t('FIREWALL')} fit>
      <div data-testid="firewall" className="flex flex-col gap-2 p-3 font-mono text-[11px] text-muted">
        <p className="text-[10.5px] text-dim">
          {t('Windows Firewall rules that keep a program off the internet even if it ignores the NETRUNNER proxy. Loopback and the local network stay open. Your own programs are not touched unless you add them here.')}
        </p>
        <ul className="flex flex-col gap-1">
          {status.programs.map(p => (
            <li key={p.path} data-fw-program={p.path} data-fw-active={p.active} className="flex items-center gap-2">
              <input type="checkbox" aria-label={t('Block internet for {name}', { name: p.label })} disabled={busy || !status.supported} checked={p.wanted} onChange={e => void act(() => api.invoke('firewall:set-program', p.path, e.target.checked))} />
              <span className="min-w-0 flex-1 truncate" title={p.path}>
                <span className={p.exists ? 'text-text' : 'text-dim line-through'}>{p.label}</span>
                {!p.builtin && <span className="text-dim"> · {p.path}</span>}
              </span>
              <span className={p.active ? 'text-success' : p.wanted ? 'text-primary' : 'text-dim'}>{p.active ? t('BLOCKED') : p.wanted ? t('NOT APPLIED') : t('OPEN')}</span>
              {!p.builtin && (
                <button title={t('Remove from the list')} disabled={busy} onClick={() => void act(() => api.invoke('firewall:remove-program', p.path))} className="text-dim hover:text-critical">
                  <Trash2 size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-1.5">
          <button data-testid="firewall-add" disabled={busy} onClick={() => void act(() => api.invoke('firewall:add-program'))} className="flex items-center gap-1 border border-line px-2 py-0.5 text-text hover:border-secondary disabled:opacity-40">
            <Plus size={11} /> {t('ADD PROGRAM')}
          </button>
          <button
            data-testid="firewall-apply"
            disabled={busy || !status.supported || !status.pending}
            onClick={() => void act(() => api.invoke('firewall:apply', 'sync'))}
            className="flex items-center gap-1 border border-primary px-2 py-0.5 text-primary disabled:opacity-40"
          >
            <ShieldCheck size={11} /> {t('APPLY (ADMIN)')}
          </button>
          {anyActive && (
            <button disabled={busy} onClick={() => void act(() => api.invoke('firewall:apply', 'clear'))} className="flex items-center gap-1 border border-critical px-2 py-0.5 text-critical disabled:opacity-40">
              <ShieldOff size={11} /> {t('REMOVE ALL RULES')}
            </button>
          )}
        </div>
        <p className="text-[10.5px] text-dim">{status.detail}</p>
      </div>
    </Panel>
  )
}

const toText = (l: string[]) => l.join('\n')
const toList = (s: string) => s.split(/[\s,]+/).filter(Boolean)

/** RULES: the operator's host rules for everything NETRUNNER starts (agents, terminal, web tools). */
export function NetRulesPanel() {
  const rules = useAi(s => s.settings?.netRules)
  const notify = useStore(s => s.notify)
  const t = useT()
  const [block, setBlock] = useState('')
  const [allow, setAllow] = useState('')
  useEffect(() => {
    if (!rules) return
    setBlock(toText(rules.block))
    setAllow(toText(rules.allow))
  }, [rules])
  if (!rules) return null
  const save = async (next: NetRules) => {
    try {
      useAi.setState({ settings: await api.invoke('settings:set-net-rules', next) })
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const dirty = toText(toList(block)) !== toText(rules.block) || toText(toList(allow)) !== toText(rules.allow)
  const area = 'h-16 w-full resize-y border border-line bg-void p-1 text-text outline-none select-text'
  return (
    <Panel title={t('RULES')} fit>
      <div data-testid="net-rules" className="flex flex-col gap-1.5 p-3 font-mono text-[11px] text-muted">
        <p className="text-[10.5px] text-dim">
          {t('Hosts for the traffic NETRUNNER starts (agents, terminal, web tools), on top of the network mode. "example.com" covers its subdomains, "*.example.com" only them. One per line.')}
        </p>
        <label>{t('ALWAYS BLOCK')}</label>
        <textarea data-testid="net-rules-block" value={block} onChange={e => setBlock(e.target.value)} placeholder="tracker.example.com" className={area} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={rules.allowOnly} onChange={e => void save({ ...rules, block: toList(block), allow: toList(allow), allowOnly: e.target.checked })} />
          {t('ONLINE TOOLS reaches only these hosts')}
        </label>
        <textarea data-testid="net-rules-allow" value={allow} onChange={e => setAllow(e.target.value)} placeholder={'github.com\nregistry.npmjs.org'} className={area} />
        <button
          data-testid="net-rules-save"
          disabled={!dirty}
          onClick={() => void save({ block: toList(block), allow: toList(allow), allowOnly: rules.allowOnly })}
          className="w-fit border border-secondary px-2 py-0.5 text-secondary disabled:opacity-40"
        >
          {t('SAVE')}
        </button>
      </div>
    </Panel>
  )
}
