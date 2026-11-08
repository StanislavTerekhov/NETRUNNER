import { monaco } from './monaco-setup'
import { api } from '@/lib/api'
import { useStore, type EditorTab } from '@/app/store'

/** Monaco languages served by NETRUNNER's language servers (pyright bundled; the others when installed). */
export const LSP_LANGUAGES = ['python', 'rust', 'go', 'c', 'cpp']

type Range = { start: { line: number; character: number }; end: { line: number; character: number } }
interface Diagnostic {
  range: Range
  severity?: number
  message: string
  source?: string
  code?: string | number
}

const toRange = (r: Range) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)
const toPos = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 })
const markup = (c: unknown): string => {
  if (!c) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(markup).filter(Boolean).join('\n\n')
  const o = c as { value?: string; language?: string }
  return o.language ? `\`\`\`${o.language}\n${o.value ?? ''}\n\`\`\`` : (o.value ?? '')
}
const SEVERITY = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint]
// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind.
const K = monaco.languages.CompletionItemKind
const KINDS = [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter]

/** Workspace path of a Monaco model (models are created with the tab path as URI). */
const opened = new Map<string, { path: string; sub: monaco.IDisposable; timer: ReturnType<typeof setTimeout> | null }>()
const pathOf = (model: monaco.editor.ITextModel) => opened.get(model.uri.toString())?.path ?? null
let installed = false

function install(): void {
  if (installed) return
  installed = true
  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', ':', '>', '(', '"', "'", '/'],
      async provideCompletionItems(model, position) {
        const p = pathOf(model)
        if (!p) return { suggestions: [] }
        const res = (await api.invoke('lsp:request', p, 'completion', toPos(position)).catch(() => null)) as
          | { items?: unknown[] }
          | unknown[]
          | null
        const items = (Array.isArray(res) ? res : (res?.items ?? [])) as { label: string; kind?: number; detail?: string; documentation?: unknown; insertText?: string; textEdit?: { newText: string }; sortText?: string; filterText?: string }[]
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        return {
          suggestions: items.slice(0, 500).map(i => ({
            label: i.label,
            kind: KINDS[i.kind ?? 1] ?? K.Text,
            detail: i.detail,
            documentation: i.documentation ? { value: markup(i.documentation) } : undefined,
            insertText: i.textEdit?.newText ?? i.insertText ?? i.label,
            sortText: i.sortText,
            filterText: i.filterText,
            range,
          })),
        }
      },
    })
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const p = pathOf(model)
        if (!p) return null
        const res = (await api.invoke('lsp:request', p, 'hover', toPos(position)).catch(() => null)) as { contents?: unknown; range?: Range } | null
        const value = markup(res?.contents)
        return value ? { contents: [{ value }], range: res?.range ? toRange(res.range) : undefined } : null
      },
    })
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(model, position) {
        const p = pathOf(model)
        if (!p) return null
        const res = (await api.invoke('lsp:request', p, 'signatureHelp', toPos(position)).catch(() => null)) as {
          signatures?: { label: string; documentation?: unknown; parameters?: { label: string | [number, number]; documentation?: unknown }[] }[]
          activeSignature?: number
          activeParameter?: number
        } | null
        if (!res?.signatures?.length) return null
        return {
          value: {
            signatures: res.signatures.map(s => ({
              label: s.label,
              documentation: s.documentation ? { value: markup(s.documentation) } : undefined,
              parameters: (s.parameters ?? []).map(pr => ({ label: pr.label, documentation: pr.documentation ? { value: markup(pr.documentation) } : undefined })),
            })),
            activeSignature: res.activeSignature ?? 0,
            activeParameter: res.activeParameter ?? 0,
          },
          dispose: () => undefined,
        }
      },
    })
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const p = pathOf(model)
        if (!p) return null
        const res = (await api.invoke('lsp:request', p, 'definition', toPos(position)).catch(() => null)) as { path: string; range: Range }[] | null
        if (!res?.length) return null
        const first = res[0]
        // Another file: open it in a tab; Monaco then jumps inside the same model when it is this one.
        if (first.path !== p) {
          void useStore.getState().openFile(first.path, first.range.start.line + 1)
          return null
        }
        return res.filter(r => r.path === p).map(r => ({ uri: model.uri, range: toRange(r.range) }))
      },
    })
  }
  api.on('lsp:diagnostics', ({ path, diagnostics }) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(path))
    if (!model) return
    monaco.editor.setModelMarkers(
      model,
      'lsp',
      (diagnostics as Diagnostic[]).map(d => ({
        ...toRange(d.range),
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
        message: d.message,
        source: d.source,
        code: d.code === undefined ? undefined : String(d.code),
      })),
    )
  })
}

/** Keep the language servers in step with the open tabs: open new ones, close removed ones. */
export function syncLsp(tabs: EditorTab[]): void {
  install()
  const live = new Set<string>()
  for (const t of tabs) {
    if (!LSP_LANGUAGES.includes(t.language)) continue
    const model = monaco.editor.getModel(monaco.Uri.parse(t.path))
    if (!model) continue
    const key = model.uri.toString()
    live.add(key)
    if (opened.has(key)) continue
    const entry = {
      path: t.path,
      timer: null as ReturnType<typeof setTimeout> | null,
      sub: model.onDidChangeContent(() => {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => void api.invoke('lsp:change', t.path, model.getValue()).catch(() => undefined), 250)
      }),
    }
    opened.set(key, entry)
    void api.invoke('lsp:open', t.path, t.language, model.getValue()).catch(() => false)
  }
  for (const [key, entry] of opened) {
    if (live.has(key)) continue
    entry.sub.dispose()
    if (entry.timer) clearTimeout(entry.timer)
    opened.delete(key)
    void api.invoke('lsp:close', entry.path).catch(() => undefined)
  }
}

/** Forget every document (the workspace changed and the servers restart). */
export function resetLsp(): void {
  for (const entry of opened.values()) entry.sub.dispose()
  opened.clear()
}
