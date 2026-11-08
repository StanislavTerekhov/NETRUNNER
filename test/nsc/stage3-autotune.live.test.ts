// NSC stage 3: the autotuner on the real models, with the same code the app runs (profiles in a scratch database).
//   NETRUNNER_LIVE=1 [NSC_MODELS=coder-next,…] npx vitest run test/nsc/stage3-autotune.live.test.ts --silent=false
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../electron/shared/autotune'
import { Autotuner, ProfileStore } from '../../electron/main/services/autotune'
import { Database } from '../../electron/main/services/db'
import { findRuntimeDir, LlamaRuntime } from '../../electron/main/services/llamacpp'

const home = path.join(os.homedir(), 'NETRUNNER')
const outDir = path.join(home, 'nsc', 'stage3')
const root = path.resolve(import.meta.dirname, '..', '..')
const db = new Database(':memory:', path.join(root, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'))
const profiles = new ProfileStore(db)
const runtime = new LlamaRuntime({
  binaryDir: () => findRuntimeDir(path.join(home, 'runtime', 'llama.cpp')),
  modelsDir: path.join(home, 'models'),
  getMode: () => 'strict-offline',
  onDownload: () => undefined,
  getProfile: id => profiles.active(id),
})
// As the app tunes them: the agent model at its agent settings (65K per lane, 1 lane + chat), the others for chat.
const MODELS = [
  { id: 'coder-next', match: 'Qwen3-Coder-Next-Q4_K_M-00001', ctx: 65536, parallel: 2 },
  { id: 'gato-27b-iq3', match: 'Qwen3.8-27B-UD-IQ3_XXS', ctx: 0, parallel: 1 },
  { id: 'netrunner-v3-4b', match: 'netrunner-netrunner-v3-Q4_K_M', ctx: 0, parallel: 1 },
]

describe.skipIf(process.env.NETRUNNER_LIVE !== '1')('NSC stage 3: autotuner on real models', () => {
  it('tunes each model and keeps only measured gains', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    const tuner = new Autotuner({
      runtime,
      profiles,
      emit: e => e.type === 'measured' && console.log(`[tune] ${e.model.split('/').pop()} ${JSON.stringify(e.profile)}: ${e.result ? `${e.result.genTokPerS} tok/s, prompt ${e.result.promptTokPerS}, load ${e.result.loadMs} ms` : e.error}${e.kept ? ' KEPT' : ''}`),
      speedsAround: () => [],
      interference: () => false,
    })
    const catalog = await runtime.catalog.list()
    const only = process.env.NSC_MODELS?.split(',')
    const report: Record<string, ModelProfile> = {}
    try {
      for (const m of MODELS.filter(m => !only || only.includes(m.id))) {
        const entry = catalog.find(e => e.id.includes(m.match))
        if (!entry) throw new Error(`model not found: ${m.match}`)
        report[m.id] = await tuner.tune(entry.id, m.ctx, m.parallel, m.id === 'coder-next' ? 'agent' : 'chat')
        const p = report[m.id]
        console.log(`[tune] ${m.id} → ${JSON.stringify(p.profile)}: defaults ${p.defaults.genTokPerS}/${p.defaultsAgain?.genTokPerS ?? '-'} → ${p.chosen.genTokPerS} tok/s; prompt ${p.defaults.promptTokPerS} → ${p.chosen.promptTokPerS}${p.note ? ` (${p.note})` : ''}`)
        fs.writeFileSync(path.join(outDir, only ? `autotune-${only.join('-')}.json` : 'autotune.json'), JSON.stringify(report, null, 2))
      }
    } finally {
      await runtime.stopAll()
    }
    expect(Object.keys(report).length).toBeGreaterThan(0)
  }, 3 * 60 * 60_000)
})
