import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DriftError } from './git.ts'

export const CONFIG_PATH = '.drift/config'

export type Policy = 'hold' | 'finish'

export interface Config {
  /** Upstream clone URL. */
  upstream: string
  /** Name of the git remote drift fetches upstream through. */
  remote: string
  /** `tags` follows release tags; anything else is an upstream branch name. */
  track: string
  /** for-each-ref glob applied to upstream tag names, e.g. `v*`. */
  tagPattern?: string
  /** Consider tags like v2.0.0-rc.1. */
  prerelease?: boolean
  /** The upstream commit the mod stack sits on. Rewritten by every finished sync. */
  pinned: { sha: string; ref: string }
  build: string
  test?: string
  install?: string
  /** Command for `check: launch`. */
  launch?: string
  /** Seconds a launched app must stay alive. */
  launchWait?: number
  /** Globs (git pathspec) for upstream test files, used to flag mods that rewrite them. */
  tests?: string[]
  /** Where sync builds the new stack. Defaults to a sibling of the repo. */
  worktree?: string
  unattended: { resolved_unverified: Policy; flagged: Policy }
}

export const DEFAULT_TESTS = [
  ':(glob)**/test/**',
  ':(glob)**/tests/**',
  ':(glob)**/__tests__/**',
  ':(glob)**/*.test.*',
  ':(glob)**/*.spec.*',
  ':(glob)**/*_test.*',
]

export function readConfig(root: string): Config {
  const p = join(root, CONFIG_PATH)
  if (!existsSync(p)) throw new DriftError('not a drift repo: .drift/config is missing (run drift init)')
  const c = JSON.parse(readFileSync(p, 'utf8')) as Config
  c.remote ??= 'upstream'
  c.track ??= 'tags'
  // The config is committed, so treat it as untrusted wherever it reaches git's argument parser.
  const name = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
  if (!name.test(c.remote)) throw new DriftError(`invalid remote name in .drift/config: ${c.remote}`)
  if (!name.test(c.track) || c.track.includes('..')) throw new DriftError(`invalid track in .drift/config: ${c.track}`)
  c.unattended = { ...({ resolved_unverified: 'hold', flagged: 'hold' } as const), ...c.unattended }
  return c
}

export function writeConfig(root: string, c: Config): void {
  const p = join(root, CONFIG_PATH)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(c, null, 2) + '\n')
}
