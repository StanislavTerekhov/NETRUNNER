import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addCrt } from '../electron/main/services/runtime-install'

describe('Visual C++ runtime next to llama.cpp', () => {
  it('copies the bundled DLLs that are missing and keeps the ones already there', async () => {
    const crt = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-crt-'))
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-rt-'))
    for (const n of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'readme.txt']) fs.writeFileSync(path.join(crt, n), 'bundled')
    fs.writeFileSync(path.join(rt, 'vcruntime140.dll'), 'shipped by llama.cpp')
    expect((await addCrt(rt, crt)).sort()).toEqual(['msvcp140.dll', 'vcruntime140_1.dll'])
    expect(fs.readFileSync(path.join(rt, 'vcruntime140.dll'), 'utf8')).toBe('shipped by llama.cpp')
    expect(fs.existsSync(path.join(rt, 'readme.txt'))).toBe(false)
    expect(await addCrt(rt, path.join(crt, 'missing'))).toEqual([])
  })

  it('the installer bundles the three DLLs llama.cpp links against', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'build', 'crt')
    expect(fs.readdirSync(dir).sort()).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
  })
})
