/**
 * Removes reasoning tags that leak into the visible answer stream. Some Qwen models (notably ones
 * fine-tuned only on non-reasoning data) emit a literal "</think>" or an empty "<think></think>" at the
 * start of the content when thinking is requested. Only the beginning of the stream is inspected,
 * so tags quoted later in an answer are left alone.
 */
export class ThinkLeakFilter {
  private buffer = ''
  private settled = false

  push(chunk: string): string {
    if (this.settled) return chunk
    this.buffer += chunk
    const stripped = this.buffer.replace(/^\s*(<think>\s*)?(<\/think>\s*)?/, '')
    const head = this.buffer.trimStart()
    // Still possibly inside a partial tag ("<", "</thi", "<think>\n\n</th") — wait for more input.
    if (head.length > 0 && head.length < 20 && ('<think>'.startsWith(head) || '</think>'.startsWith(head) || /^<think>\s*<?\/?t?h?i?n?k?$/.test(head))) {
      return ''
    }
    if (stripped.length === 0) return ''
    this.settled = true
    this.buffer = ''
    return stripped
  }

  /** Flush whatever is buffered when the stream ends (e.g. an answer that is just "<"). */
  end(): string {
    if (this.settled) return ''
    this.settled = true
    const rest = this.buffer.replace(/^\s*(<think>\s*)?(<\/think>\s*)?/, '')
    this.buffer = ''
    return rest
  }
}
