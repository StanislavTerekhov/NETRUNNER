import { create } from 'zustand'
import type { AgentEngineState, AgentGrant, AgentPart, AgentPermission, AgentRole, AgentSessionInfo, AgentTask, ChangedFile } from '../../electron/shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useStore } from './store'
import { t } from '@/lib/i18n'

interface AgentState {
  engine: AgentEngineState | null
  sessions: AgentSessionInfo[]
  sessionId: string | null
  parts: Record<string, AgentPart[]>
  busy: Record<string, boolean>
  statusDetail: Record<string, string | null>
  permissions: AgentPermission[]
  /** Standing ALWAYS approvals of the running engine (exact command / file). */
  grants: AgentGrant[]
  /** Requests answered by a standing approval, newest last (shown so nothing passes unseen). */
  autoApproved: { permission: AgentPermission; grant: AgentGrant; at: string }[]
  errors: Record<string, string[]>
  tokens: Record<string, { input: number; output: number }>
  role: AgentRole
  tasks: AgentTask[]
  selectedTask: number | null
  /** Follow the running task in the transcript until the operator picks another one. */
  follow: boolean
  useMemory: boolean
  /** Parallel agent jobs set for the next engine start (the running engine reports its own in engine.lanes). */
  lanes: number
  /** Changed files of worktree jobs waiting for MERGE, by job id. */
  jobFiles: Record<string, ChangedFile[]>

  refresh(): Promise<void>
  revokeGrant(key: string): Promise<void>
  setLanes(n: number): Promise<void>
  loadJobFiles(jobId: string): Promise<void>
  mergeJob(jobId: string): Promise<void>
  discardJob(jobId: string): Promise<void>
  start(model: string): Promise<void>
  stop(): Promise<void>
  newSession(title: string): Promise<string | null>
  openSession(id: string): Promise<void>
  enqueue(text: string): Promise<void>
  pipeline(goal: string): Promise<void>
  selectTask(id: number): Promise<void>
  cancelTask(id: number): Promise<void>
  retryTask(id: number): Promise<void>
  respond(p: AgentPermission, response: 'once' | 'always' | 'reject'): Promise<void>
  setRole(role: AgentRole): void
  setUseMemory(on: boolean): void
}

const notifyError = (err: unknown) => useStore.getState().notify('error', errorMessage(err))

function upsert(list: AgentPart[], part: AgentPart): AgentPart[] {
  const i = list.findIndex(p => p.id === part.id)
  if (i < 0) return [...list, part]
  const next = list.slice()
  next[i] = part
  return next
}

export const useAgent = create<AgentState>((set, get) => {
  const applyTasks = (tasks: AgentTask[]) => {
    set({ tasks })
    // With parallel jobs several tasks run at once: follow the one that started last.
    const running = tasks.filter(t => t.status === 'running').sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]
    if (get().follow && running?.sessionId && get().selectedTask !== running.id) {
      set({ selectedTask: running.id })
      void get().openSession(running.sessionId)
    }
  }
  api.on('tasks:changed', applyTasks)

  api.on('agent:event', ev => {
    switch (ev.type) {
      case 'engine':
        set({ engine: ev.state })
        if (ev.state.status !== 'running') set({ busy: {}, permissions: [], grants: [] })
        break
      case 'part':
        set(s => ({ parts: { ...s.parts, [ev.sessionId]: upsert(s.parts[ev.sessionId] ?? [], ev.part) } }))
        break
      case 'status':
        set(s => ({ busy: { ...s.busy, [ev.sessionId]: ev.busy }, statusDetail: { ...s.statusDetail, [ev.sessionId]: ev.detail } }))
        if (!ev.busy) void get().refresh()
        break
      case 'permission':
        set(s => ({ permissions: [...s.permissions.filter(p => p.id !== ev.permission.id), ev.permission] }))
        break
      case 'permission-replied':
        set(s => ({ permissions: s.permissions.filter(p => p.id !== ev.permissionId) }))
        break
      case 'permission-auto':
        set(s => ({
          autoApproved: [...s.autoApproved, { permission: ev.permission, grant: ev.grant, at: new Date().toISOString() }].slice(-50),
          grants: s.grants.map(g => (g.key === ev.grant.key ? ev.grant : g)),
        }))
        break
      case 'error': {
        const key = ev.sessionId ?? '_engine'
        set(s => ({ errors: { ...s.errors, [key]: [...(s.errors[key] ?? []), ev.message].slice(-5) } }))
        break
      }
      case 'tokens':
        set(s => ({ tokens: { ...s.tokens, [ev.sessionId]: { input: ev.input, output: ev.output } } }))
        break
    }
  })

  return {
    engine: null,
    sessions: [],
    sessionId: null,
    parts: {},
    busy: {},
    statusDetail: {},
    permissions: [],
    grants: [],
    autoApproved: [],
    errors: {},
    tokens: {},
    role: 'coder',
    tasks: [],
    selectedTask: null,
    follow: true,
    useMemory: false,
    lanes: 1,
    jobFiles: {},

    async refresh() {
      const [engine, settings] = await Promise.all([api.invoke('agent:state'), api.invoke('settings:get')])
      set({ engine, lanes: settings.agentLanes })
      if (useStore.getState().workspace) applyTasks(await api.invoke('tasks:list').catch(() => []))
      if (engine.status === 'running') {
        try {
          set({ sessions: await api.invoke('agent:sessions') })
        } catch (err) {
          notifyError(err)
        }
      }
    },

    async start(model) {
      try {
        set({ engine: await api.invoke('agent:start', model), sessions: [], sessionId: null })
        await get().refresh()
      } catch (err) {
        notifyError(err)
        await get().refresh()
      }
    },

    async stop() {
      set({ engine: await api.invoke('agent:stop') })
    },

    async newSession(title) {
      try {
        const s = await api.invoke('agent:create-session', title)
        set(st => ({ sessions: [s, ...st.sessions], sessionId: s.id, parts: { ...st.parts, [s.id]: [] } }))
        return s.id
      } catch (err) {
        notifyError(err)
        return null
      }
    },

    async openSession(id) {
      set({ sessionId: id })
      try {
        const history = await api.invoke('agent:history', id)
        set(s => ({ parts: { ...s.parts, [id]: history } }))
      } catch (err) {
        notifyError(err)
      }
    },

    // Every task goes through the main-process queue: one at a time, checkpointed, persisted.
    async enqueue(text) {
      try {
        set({ follow: true })
        await api.invoke('tasks:enqueue', { role: get().role, prompt: text, useMemory: get().useMemory })
      } catch (err) {
        notifyError(err)
      }
    },

    async pipeline(goal) {
      try {
        set({ follow: true })
        await api.invoke('tasks:pipeline', goal, get().useMemory)
      } catch (err) {
        notifyError(err)
      }
    },

    async selectTask(id) {
      const task = get().tasks.find(t => t.id === id)
      const running = get().tasks.find(t => t.status === 'running')
      set({ selectedTask: id, follow: running?.id === id })
      if (task?.sessionId) await get().openSession(task.sessionId)
      else set({ sessionId: null })
    },

    async cancelTask(id) {
      await api.invoke('tasks:cancel', id).catch(notifyError)
    },

    async retryTask(id) {
      set({ follow: true })
      await api.invoke('tasks:retry', id).catch(notifyError)
    },

    async respond(p, response) {
      try {
        await api.invoke('agent:respond', p.sessionId, p.id, response)
        set(s => ({ permissions: s.permissions.filter(x => x.id !== p.id) }))
        if (response === 'always') set({ grants: await api.invoke('agent:grants') })
      } catch (err) {
        notifyError(err)
      }
    },

    async revokeGrant(key) {
      try {
        set({ grants: await api.invoke('agent:revoke-grant', key) })
      } catch (err) {
        notifyError(err)
      }
    },

    async setLanes(n) {
      try {
        set({ lanes: (await api.invoke('settings:set-agent-lanes', n)).agentLanes })
      } catch (err) {
        notifyError(err)
      }
    },

    async loadJobFiles(jobId) {
      const files = await api.invoke('tasks:job-changes', jobId).catch(() => [])
      set(s => ({ jobFiles: { ...s.jobFiles, [jobId]: files } }))
    },

    async mergeJob(jobId) {
      try {
        const job = await api.invoke('tasks:merge-job', jobId)
        const notify = useStore.getState().notify
        if (job.conflicts.length) notify('error', t('Merged with conflicts in {files} — resolve the markers, then review in GIT', { files: job.conflicts.join(', ') }))
        else notify('success', t('Job {id} merged into the workspace', { id: jobId }))
        void useStore.getState().refreshTree()
      } catch (err) {
        if (!/cancelled/.test(errorMessage(err))) notifyError(err)
      }
    },

    async discardJob(jobId) {
      try {
        await api.invoke('tasks:discard-job', jobId)
      } catch (err) {
        if (!/cancelled/.test(errorMessage(err))) notifyError(err)
      }
    },

    setRole: role => set({ role }),
    setUseMemory: useMemory => set({ useMemory }),
  }
})
