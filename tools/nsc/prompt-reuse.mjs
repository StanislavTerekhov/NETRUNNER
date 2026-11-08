// NSC: how much of each prompt llama-server read again, from a full server log (NETRUNNER_SERVER_LOG_DIR).
// Per request: prompt tokens, tokens processed (the rest came from the cache), prompt and generation time.
//   node tools/nsc/prompt-reuse.mjs <server.log> [...]
import fs from 'node:fs'

export function promptReuse(text) {
  const tasks = new Map()
  const get = id => tasks.get(id) ?? tasks.set(id, { task: id }).get(id)
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/task (\d+) \| (.*)$/)
    if (!m) continue
    const t = get(Number(m[1]))
    let x
    if ((x = m[2].match(/^prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/))) Object.assign(t, { promptMs: Number(x[1]), processed: Number(x[2]) })
    else if ((x = m[2].match(/^\s*eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/))) Object.assign(t, { genMs: Number(x[1]), generated: Number(x[2]) })
    else if ((x = m[2].match(/stop processing: n_tokens = (\d+)/))) t.finalTokens = Number(x[1])
  }
  const requests = [...tasks.values()]
    .filter(t => t.processed !== undefined && t.finalTokens !== undefined)
    .map(t => ({ ...t, promptTokens: Math.max(t.processed, t.finalTokens - (t.generated ?? 0)) }))
  const sum = k => requests.reduce((n, r) => n + (r[k] ?? 0), 0)
  return {
    requests: requests.length,
    promptTokens: sum('promptTokens'),
    processed: sum('processed'),
    reprocessedPct: Math.round((sum('processed') / Math.max(1, sum('promptTokens'))) * 1000) / 10,
    promptSeconds: Math.round(sum('promptMs') / 100) / 10,
    genSeconds: Math.round(sum('genMs') / 100) / 10,
    // Requests that read more than 1000 tokens: in an agent run these are the starts of new steps.
    bigReads: requests.filter(r => r.processed > 1000).map(r => ({ promptTokens: r.promptTokens, processed: r.processed, seconds: Math.round(r.promptMs / 100) / 10 })),
    perRequest: requests.map(r => ({ task: r.task, promptTokens: r.promptTokens, processed: r.processed, promptS: Math.round(r.promptMs / 100) / 10, generated: r.generated })),
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  for (const f of process.argv.slice(2)) {
    const r = promptReuse(fs.readFileSync(f, 'utf8'))
    console.log(JSON.stringify({ file: f, ...r, perRequest: undefined }, null, 1))
  }
}
