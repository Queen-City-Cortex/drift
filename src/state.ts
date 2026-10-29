import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Repo, type Target } from './repo.ts'
import { DriftError } from './git.ts'

/** One step of rebuilding the stack: pick a commit, or squash one into the commit below it. */
export interface Op {
  sha: string
  mod?: string
  init?: boolean
  squash?: boolean
}

export type Outcome = 'clean' | 'resolved' | 'absorbed' | 'dropped'

export interface ModRecord {
  mod: string
  subject: string
  /** The mod's commit before this sync. */
  oldSha: string
  outcome: Outcome
  conflicted: string[]
  /** The agent edited this mod (conflict resolution or fixup). */
  agentTouched: boolean
  /** Patches of what the agent wrote, relative to what git produced mechanically. */
  agentPatches: string[]
}

export interface CheckResult {
  name: string
  check: string
  ok: boolean
  unverified: boolean
  attempts: number
  exhausted: boolean
  log?: string
  tail?: string
}

export interface VerifyResult {
  green: boolean
  tip: string
  build: CheckResult
  test?: CheckResult
  mods: CheckResult[]
}

export interface SyncState {
  status: 'applying' | 'conflict' | 'applied' | 'held'
  startedAt: string
  /** Main checkout HEAD when the sync started; abort returns here. */
  checkpoint: string
  branch: string
  from: Target
  to: Target
  worktree: string
  without: string[]
  unattended: boolean
  queue: Op[]
  current?: Op & { markersTree: string; conflicted: string[] }
  mods: Record<string, ModRecord>
  attempts: Record<string, number>
  verified?: VerifyResult
}

export const MAX_ATTEMPTS = 2

const file = (repo: Repo) => join(repo.stateDir, 'sync.json')

export function loadState(repo: Repo): SyncState | undefined {
  return existsSync(file(repo)) ? (JSON.parse(readFileSync(file(repo), 'utf8')) as SyncState) : undefined
}

export function requireState(repo: Repo): SyncState {
  const s = loadState(repo)
  if (!s) throw new DriftError('no sync in progress')
  return s
}

export function saveState(repo: Repo, s: SyncState): void {
  writeFileSync(file(repo), JSON.stringify(s, null, 2))
}

export function clearState(repo: Repo): void {
  rmSync(file(repo), { force: true })
  rmSync(join(repo.stateDir, 'patches'), { recursive: true, force: true })
  rmSync(join(repo.stateDir, 'logs'), { recursive: true, force: true })
}
