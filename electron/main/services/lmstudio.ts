import fs from 'node:fs'
import path from 'node:path'

/** Where LM Studio keeps its home: `~/.lmstudio`, unless `~/.lmstudio-home-pointer` names another folder. */
function lmStudioHome(home: string): string {
  try {
    const pointer = fs.readFileSync(path.join(home, '.lmstudio-home-pointer'), 'utf8').trim()
    if (pointer && path.isAbsolute(pointer) && fs.existsSync(pointer)) return pointer
  } catch {
    /* no pointer file */
  }
  return path.join(home, '.lmstudio')
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * LM Studio's models folder (publisher/repo/file.gguf). An explicit folder from the settings wins; otherwise
 * the "downloadsFolder" from LM Studio's own settings, then its defaults (current and pre-0.3 layouts).
 * NETRUNNER only reads these files and runs them with its own llama.cpp; LM Studio itself is not started.
 */
export function findLmStudioModelsDir(home: string, override: string | null): string | null {
  if (override) return isDir(override) ? override : null
  const lmHome = lmStudioHome(home)
  try {
    const text = fs.readFileSync(path.join(lmHome, 'settings.json'), 'utf8').replace(/^﻿/, '')
    const folder = (JSON.parse(text) as { downloadsFolder?: unknown }).downloadsFolder
    if (typeof folder === 'string' && path.isAbsolute(folder) && isDir(folder)) return folder
  } catch {
    /* LM Studio not configured or not installed */
  }
  return [path.join(lmHome, 'models'), path.join(home, '.cache', 'lm-studio', 'models')].find(isDir) ?? null
}
