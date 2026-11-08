/**
 * Readable text from a web page for the model: the main content (<main>/<article> when present) as light Markdown —
 * headings, lists, code blocks, links — without scripts, styles, navigation or markup. No DOM, no dependencies.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** The innermost-first content region: <main>, else the longest <article>, else <body>. */
function contentRegion(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
  if (main && main[1].length > 500) return main[1]
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(m => m[1]).sort((a, b) => b.length - a.length)
  if (articles[0] && articles[0].length > 500) return articles[0]
  return html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html
}

export function htmlTitle(html: string): string {
  return decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
}

export function htmlToText(html: string, baseUrl: string): string {
  let s = contentRegion(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1>/gi, '')
  const codeBlocks: string[] = []
  // <pre> keeps its line breaks; stash it before whitespace is collapsed.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const text = decodeEntities(body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    codeBlocks.push('\n```\n' + text.replace(/\n+$/, '') + '\n```\n')
    return `\u0000${codeBlocks.length - 1}\u0000`
  })
  const abs = (href: string) => {
    try {
      const u = new URL(decodeEntities(href), baseUrl)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
    } catch {
      return null
    }
  }
  s = s
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const url = abs(href)
      return text && url && !url.startsWith(baseUrl + '#') ? `[${text}](${url})` : text
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => '`' + inner.replace(/<[^>]+>/g, '') + '`')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|dd|dt|figure|header)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)])
  return s.trim()
}
