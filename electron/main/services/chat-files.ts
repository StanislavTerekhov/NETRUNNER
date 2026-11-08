import type { ChatFileRequest, ChatFileResult, ChatFileWrites } from '../../shared/ipc'

const MAX_FILES = 20

export interface ChatFileDeps {
  /** Current content, or null when the file does not exist. */
  read(path: string): Promise<string | null>
  put(path: string, content: string): Promise<{ path: string; previous: string | null }>
  /** Moves a file to the recycle bin. */
  remove(path: string): Promise<void>
  /** Asks the user (main-process dialog); the list says what would be written. */
  confirm(lines: string[], partial: boolean): Promise<boolean>
}

const lineCount = (s: string) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0)

/** Renderer input, checked: a list of {path, content, partial}. */
export function checkRequests(files: unknown): ChatFileRequest[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw new Error(`Between 1 and ${MAX_FILES} files`)
  return files.map(f => {
    const o = (f ?? {}) as Record<string, unknown>
    if (typeof o.path !== 'string' || !o.path || o.path.length > 260 || typeof o.content !== 'string') throw new Error('Malformed file request')
    return { path: o.path, content: o.content, partial: o.partial === true }
  })
}

/**
 * Writes chat code blocks according to the mode the user chose in settings. The decision is made here, in the main
 * process, so the renderer cannot write past the user's choice:
 * - ask: nothing on 'auto'; SAVE asks every time;
 * - limited: 'auto' writes new files only; SAVE writes new files and asks before overwriting;
 * - full: 'auto' writes everything that is a whole file; SAVE writes without asking.
 * An excerpt ("// ... existing code") is never written automatically and replacing a file with one is always asked.
 */
export async function writeChatFiles(deps: ChatFileDeps, files: ChatFileRequest[], trigger: 'auto' | 'manual', mode: ChatFileWrites): Promise<ChatFileResult[]> {
  const results: ChatFileResult[] = []
  const toWrite: { file: ChatFileRequest; current: string | null; index: number }[] = []
  const toConfirm: { file: ChatFileRequest; current: string | null; index: number }[] = []
  for (const file of files) {
    let current: string | null
    try {
      current = await deps.read(file.path)
    } catch (err) {
      results.push({ path: file.path, status: 'error', previous: null, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    const index = results.push({ path: file.path, status: 'pending', previous: current }) - 1
    if (current === file.content) {
      results[index].status = 'unchanged'
      continue
    }
    const isNew = current === null
    const item = { file, current, index }
    if (trigger === 'auto') {
      if (file.partial || mode === 'ask' || (mode === 'limited' && !isNew)) continue // stays pending: SAVE button
      toWrite.push(item)
    } else if (mode === 'ask' || (file.partial && !isNew) || (mode === 'limited' && !isNew)) toConfirm.push(item)
    else toWrite.push(item)
  }
  if (toConfirm.length) {
    const lines = toConfirm.map(({ file, current }) =>
      current === null ? `+ ${file.path} (${lineCount(file.content)})` : `~ ${file.path} (${lineCount(current)} → ${lineCount(file.content)})`,
    )
    if (await deps.confirm(lines, toConfirm.some(c => c.file.partial && c.current !== null))) toWrite.push(...toConfirm)
  }
  for (const { file, current, index } of toWrite) {
    try {
      const done = await deps.put(file.path, file.content)
      results[index] = { path: done.path, status: current === null ? 'created' : 'overwritten', previous: done.previous }
    } catch (err) {
      results[index] = { path: file.path, status: 'error', previous: current, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return results
}

/**
 * Undo chat writes: put the previous content back; a file the chat created goes to the recycle bin. Only while the
 * file still holds what that write put there (`expected`): a later write or edit is never thrown away.
 */
export async function undoChatFiles(deps: ChatFileDeps, writes: unknown): Promise<ChatFileResult[]> {
  if (!Array.isArray(writes) || writes.length === 0 || writes.length > MAX_FILES) throw new Error(`Between 1 and ${MAX_FILES} files`)
  const out: ChatFileResult[] = []
  for (const w of writes as { path?: unknown; previous?: unknown; expected?: unknown }[]) {
    const path = typeof w?.path === 'string' ? w.path : ''
    const previous = typeof w?.previous === 'string' ? w.previous : null
    try {
      if (!path || typeof w?.expected !== 'string') throw new Error('Malformed undo request')
      if ((await deps.read(path)) !== w.expected) throw new Error('The file changed after this write; undo the later change first')
      if (previous === null) await deps.remove(path)
      else await deps.put(path, previous)
      out.push({ path, status: 'undone', previous: null })
    } catch (err) {
      out.push({ path, status: 'error', previous, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
