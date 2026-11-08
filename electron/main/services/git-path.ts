import fs from 'node:fs'
import path from 'node:path'

/**
 * Git for Windows installed while NETRUNNER's installer ran (or just before NETRUNNER started) is not yet on the PATH
 * this process inherited. Returns the PATH with Git's cmd folder appended when git is missing from it but sits in one
 * of the standard install folders; otherwise the PATH unchanged.
 */
export function pathWithGit(pathEnv: string, env: Record<string, string | undefined> = process.env): string {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  if (dirs.some(d => fs.existsSync(path.join(d, 'git.exe')))) return pathEnv
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'cmd'),
  ].filter((d): d is string => !!d)
  const found = candidates.find(d => fs.existsSync(path.join(d, 'git.exe')))
  return found ? [...dirs, found].join(path.delimiter) : pathEnv
}
