import { Fragment, type ReactNode } from 'react'
import { codeFilePath, looksPartial } from '../lib/code-files'

/**
 * Minimal Markdown renderer for model output. It builds React elements only (no innerHTML), so model
 * text can never inject markup or scripts. Supports headings, fenced code, tables, lists, quotes,
 * paragraphs and inline code / bold / italic / links (https only) / images (inline data: only).
 */
export type Block =
  /** path: the workspace file the block is meant to be (see code-files.ts), or null. */
  | { kind: 'code'; lang: string; text: string; path: string | null }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```\s*(.*)$/)
    if (fence) {
      const info = fence[1].trim()
      let above = ''
      for (let j = i - 1; j >= 0 && !above; j--) above = lines[j].trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or end of input while streaming)
      const lang = (info.match(/^[\w+#-]*/)?.[0] ?? '').replace(/:$/, '')
      blocks.push({ kind: 'code', lang, text: body.join('\n'), path: codeFilePath(info, above) })
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      const ordered = /\d/.test(li[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (!m || /\d/.test(m[1]) !== ordered) break
        items.push(m[2])
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: q.join('\n') })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*([-*+]|\d+[.)])\s|\s*>)/.test(lines[i])) para.push(lines[i++])
    if (para.length === 0) para.push(lines[i++]) // safety: always make progress
    blocks.push({ kind: 'para', text: para.join('\n') })
  }
  return blocks
}

/** Only https links open (in the system browser, after a click); anything else stays text. */
export const safeLink = (url: string): string | null => (/^https:\/\/[^\s<>"']+$/i.test(url) ? url : null)

/** Only inline data: pictures render; remote images would be a network request, so they show as links instead. */
export const safeImage = (url: string): string | null => (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(url) ? url : null)

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={e => {
        e.preventDefault()
        // The main process opens https URLs in the system browser and denies the new window.
        window.open(href)
      }}
      className="text-secondary underline decoration-secondary/40 underline-offset-2 hover:decoration-secondary"
    >
      {children}
    </a>
  )
}

/** Inline `code`, **bold**, *italic*, ![image](data:…), [links](https://…) and bare https URLs; everything else stays literal text. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|https:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]|\*\*[^*]+\*\*|(?<![*\w])\*[^*\s][^*]*\*(?![*\w]))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const linkish = tok.match(/^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/)
    if (tok.startsWith('`')) out.push(<code key={k++} className="bg-void px-1 font-mono text-[0.92em] text-secondary">{tok.slice(1, -1)}</code>)
    else if (linkish?.[1]) {
      const [, , alt, url] = linkish
      const src = safeImage(url)
      const href = safeLink(url)
      if (src) out.push(<img key={k++} src={src} alt={alt} className="my-1 max-h-72 max-w-full border border-line" />)
      else if (href) out.push(<Link key={k++} href={href}>{`image: ${alt || href}`}</Link>)
      else out.push(tok)
    } else if (linkish) {
      const [, , label, url] = linkish
      const href = safeLink(url)
      out.push(href ? <Link key={k++} href={href}>{inline(label)}</Link> : label)
    } else if (tok.startsWith('https://')) out.push(<Link key={k++} href={tok}>{tok}</Link>)
    else if (tok.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-text">{tok.slice(2, -2)}</strong>)
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Files a finished answer offers to write: the last block per path wins; excerpts are flagged as partial. */
export function extractCodeFiles(text: string): { path: string; content: string; partial: boolean }[] {
  const byPath = new Map<string, { path: string; content: string; partial: boolean }>()
  for (const b of parseMarkdown(text)) {
    if (b.kind !== 'code' || !b.path) continue
    byPath.set(b.path, { path: b.path, content: b.text.endsWith('\n') ? b.text : `${b.text}\n`, partial: looksPartial(b.text) })
  }
  return [...byPath.values()]
}

export function Markdown({ text, renderCode }: { text: string; renderCode?: (lang: string, code: string, key: number, path: string | null) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {parseMarkdown(text).map((b, i) => {
        switch (b.kind) {
          case 'code':
            return renderCode ? (
              <Fragment key={i}>{renderCode(b.lang, b.text, i, b.path)}</Fragment>
            ) : (
              <pre key={i} className="overflow-x-auto border border-line bg-void p-2 font-mono text-[12px]">
                {b.text}
              </pre>
            )
          case 'heading':
            return (
              <div key={i} className={`font-semibold text-primary ${b.level <= 2 ? 'text-[14px]' : 'text-[13px]'}`}>
                {inline(b.text)}
              </div>
            )
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="border-collapse font-mono text-[11.5px]">
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j} className="border border-line bg-surface px-2 py-0.5 text-left font-semibold text-muted">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, n) => (
                          <td key={n} className="border border-line px-2 py-0.5 align-top">
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L key={i} className={`ml-5 flex flex-col gap-0.5 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-dim`}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </L>
            )
          }
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-secondary/50 pl-2 text-muted whitespace-pre-wrap">
                {inline(b.text)}
              </blockquote>
            )
          case 'rule':
            return <hr key={i} className="border-line" />
          case 'para':
            return (
              <p key={i} className="whitespace-pre-wrap">
                {inline(b.text)}
              </p>
            )
        }
      })}
    </div>
  )
}
