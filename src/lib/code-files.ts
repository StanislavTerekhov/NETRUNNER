/**
 * Code blocks in a chat answer that name a file: the model writes ```ts path=src/app.ts (or ```ts:src/app.ts, or a
 * "File: `src/app.ts`" line right above the block). Those blocks can be written into the workspace.
 */

/** Relative workspace path in forward-slash form, or null when it is not a plausible file path. */
export function cleanPath(raw: string): string | null {
  let p = raw.trim().replace(/^["'`]+|["'`,;:]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p || p.length > 260 || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || /[<>:"|?*\x00-\x1f]/.test(p)) return null
  const parts = p.split('/')
  if (parts.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || s.toLowerCase() === '.git')) return null
  // A file name, not a bare word: an extension, a dotfile or a well-known extensionless name.
  const name = parts[parts.length - 1]
  if (!/\.[\w-]+$/.test(name) && !/^(Makefile|Dockerfile|LICENSE|Procfile|Gemfile|Rakefile|CMakeLists\.txt)$/.test(name)) return null
  p = parts.join('/')
  return p
}

/** Path named by a fence info string ("ts path=src/a.ts", "ts:src/a.ts") or by the line just above the fence. */
export function codeFilePath(info: string, lineAbove: string): string | null {
  const attr = info.match(/\b(?:path|file|filename|title)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i)
  if (attr) return cleanPath(attr[1] ?? attr[2] ?? attr[3])
  const colon = info.trim().match(/^[\w+#-]+:(\S+)$/)
  if (colon) return cleanPath(colon[1])
  const above = lineAbove.match(/^[\s#>*_-]*(?:file|файл|path|путь)\s*[:：]?\s*\**\s*`?([^\s`*]+)`?\**\s*:?\s*$/i)
  return above ? cleanPath(above[1]) : null
}

/**
 * The block is an excerpt, not the whole file ("// ... existing code ..."): writing it would cut the file down to
 * the excerpt, so such blocks are never written automatically.
 */
export function looksPartial(code: string): boolean {
  return code.split('\n').some(
    l =>
      /^\s*(\/\/|#|\/\*|<!--|--|;|\*)\s*(\.{3}|…)/.test(l) ||
      /^\s*(\/\/|#|\/\*|<!--|--|;)\s*.*\b(existing code|rest of (the )?(file|code|class|function)|unchanged|as before|same as before)\b/i.test(l) ||
      /^\s*(\/\/|#|\/\*|<!--|--|;)\s*.*(остальн\S* код|без изменений|как раньше|как было)/i.test(l) ||
      /^\s*\.{3}\s*$/.test(l),
  )
}
