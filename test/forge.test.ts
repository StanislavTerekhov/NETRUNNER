import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listForgeRuns } from '../electron/main/services/forge'

describe('listForgeRuns', () => {
  it('reports only the steps whose files exist', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'netrunner-forge-'))
    const full = path.join(home, 'runs', 'full')
    const partial = path.join(home, 'runs', 'partial')
    await fs.mkdir(full, { recursive: true })
    await fs.mkdir(partial, { recursive: true })
    const ds = { train_samples: 300, eval_samples: 30, teacher: 'qwen3.6:35b', workspace: 'C:\\p', chunks: 79 }
    await fs.writeFile(path.join(full, 'dataset_stats.json'), JSON.stringify(ds))
    await fs.writeFile(path.join(partial, 'dataset_stats.json'), '\uFEFF' + JSON.stringify(ds))
    await fs.writeFile(
      path.join(full, 'train_report.json'),
      JSON.stringify({ base: 'b', epochs: 3, lora_rank: 32, eval_loss_before: 1.9, eval_loss_after: 0.8, train_seconds: 600, peak_vram_gb: 9.5 }),
    )
    await fs.writeFile(path.join(full, 'bench_report.json'), JSON.stringify({ summary: { models: ['base.gguf', 'tuned.gguf'], mmlu: { 'base.gguf': 61.4, 'tuned.gguf': 60.7 }, mmlu_n: 285, gsm8k: { 'base.gguf': 80 } } }))
    await fs.writeFile(path.join(full, 'exported_model.txt'), 'netrunner/netrunner-qwen3.5-4b-Q4_K_M.gguf\n')

    const [f, p] = await listForgeRuns(home)
    expect(f.name).toBe('full')
    expect(f.training).toMatchObject({ evalLossBefore: 1.9, evalLossAfter: 0.8 })
    expect(f.exportedModel).toBe('netrunner/netrunner-qwen3.5-4b-Q4_K_M.gguf')
    expect(f.evaluation).toBeNull()
    // Only suites with numbers for both models are reported.
    expect(f.bench).toEqual({ baseModel: 'base.gguf', tunedModel: 'tuned.gguf', suites: [{ suite: 'mmlu', n: 285, base: 61.4, tuned: 60.7 }] })
    expect(p.bench).toBeNull()
    expect(p.dataset?.trainSamples).toBe(300)
    expect(p.training).toBeNull()
    expect(await listForgeRuns(path.join(home, 'missing'))).toEqual([])
    await fs.rm(home, { recursive: true, force: true })
  })
})
