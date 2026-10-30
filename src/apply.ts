import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_PATH, type Config } from './config.ts'
import { DriftError, git, paths, tryGit } from './git.ts'
import { intentPath } from './mods.ts'
import { type Repo } from './repo.ts'
import { type Op, type SyncState, saveState } from './state.ts'

export interface Conflict {
  status: 'conflict'
  mod: string
  intent_path: string
  conflicted_files: string[]
  from: string
  to: string
  worktree: string
}

export interface Applied {
  status: 'applied'
  next: 'verify'
  mods: { mod: string; outcome: string }[]
}

const unmerged = (wt: string) => paths(wt, ['diff', '--name-only', '--diff-filter=U'])

/** Snapshot the working tree, conflict markers and all, without touching the real index. */
function snapshotTree(repo: Repo, wt: string): string {
  const index = join(repo.stateDir, 'snapshot.index')
  rmSync(index, { force: true })
  const env = { GIT_INDEX_FILE: index }
  git(wt, ['read-tree', 'HEAD'], undefined, env)
  git(wt, ['add', '-A'], undefined, env)
  const tree = git(wt, ['write-tree'], undefined, env)
  rmSync(index, { force: true })
  return tree
}

export function savePatch(repo: Repo, name: string, patch: string): string {
  const dir = join(repo.stateDir, 'patches')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${name}.patch`)
  writeFileSync(p, patch)
  return p
}

/** Commits the op already applied to the index (cherry-pick --no-commit or a resolved conflict). */
function commitOp(state: SyncState, wt: string, op: Op, resolvedByAgent = false): void {
  if (op.init) {
    const p = join(wt, CONFIG_PATH)
    const c = JSON.parse(readFileSync(p, 'utf8')) as Config
    c.pinned = { sha: state.to.sha, ref: state.to.ref }
    writeFileSync(p, JSON.stringify(c, null, 2) + '\n')
    git(wt, ['add', CONFIG_PATH])
  }
  if (op.squash) {
    git(wt, ['commit', '--quiet', '--no-verify', '--allow-empty', '--amend', '--no-edit'])
  } else if (op.mod && !resolvedByAgent && isAbsorbed(wt)) {
    // Upstream already does what this mod did: only its intent file would remain.
    // Never inferred from an agent's resolution, which may simply have lost the mod.
    git(wt, ['reset', '--quiet', '--hard', 'HEAD'])
    git(wt, ['update-ref', `refs/drift/absorbed/${op.mod}`, op.sha])
    state.mods[op.mod].outcome = 'absorbed'
  } else {
    git(wt, ['commit', '--quiet', '--no-verify', '--allow-empty', '-C', op.sha])
  }
  tryGit(wt, ['cherry-pick', '--quit'])
}

function isAbsorbed(wt: string): boolean {
  return paths(wt, ['diff', '--cached', '--name-only', 'HEAD']).every((f) => f.startsWith('.drift/'))
}

/** Runs the queue until it is empty or a pick conflicts. */
export function runQueue(repo: Repo, state: SyncState): Conflict | Applied {
  const wt = state.worktree
  while (state.queue.length) {
    const op = state.queue[0]
    const pick = tryGit(wt, ['cherry-pick', '--no-commit', '--allow-empty', op.sha])
    if (!pick.ok) {
      const conflicted = unmerged(wt)
      if (!conflicted.length) throw new DriftError(`cherry-pick of ${op.sha} failed: ${pick.out}`)
      state.status = 'conflict'
      state.current = { ...op, markersTree: snapshotTree(repo, wt), conflicted }
      if (op.mod) state.mods[op.mod].conflicted = [...new Set([...state.mods[op.mod].conflicted, ...conflicted])]
      saveState(repo, state)
      return conflictInfo(state)
    }
    commitOp(state, wt, op)
    state.queue.shift()
    saveState(repo, state)
  }
  state.status = 'applied'
  state.current = undefined
  saveState(repo, state)
  return {
    status: 'applied',
    next: 'verify',
    mods: Object.values(state.mods).map((m) => ({ mod: m.mod, outcome: m.outcome })),
  }
}

export function conflictInfo(state: SyncState): Conflict {
  const c = state.current!
  const mod = c.mod ?? (c.init ? 'init' : 'unknown')
  return {
    status: 'conflict',
    mod,
    intent_path: c.mod ? join(state.worktree, intentPath(c.mod)) : join(state.worktree, CONFIG_PATH),
    conflicted_files: c.conflicted,
    from: state.from.ref,
    to: state.to.ref,
    worktree: state.worktree,
  }
}

const MARKER = /^(<{7}|>{7})( |$)/m

/** Accepts the agent's resolution of the current conflict and records what it wrote. */
export function resolveCurrent(repo: Repo, state: SyncState): void {
  const wt = state.worktree
  const c = state.current
  if (state.status !== 'conflict' || !c) throw new DriftError('no conflict to continue from')
  git(wt, ['add', '-A'])
  const stillMarked = c.conflicted.filter((f) => {
    const r = tryGit(wt, ['show', `:${f}`])
    return r.ok && MARKER.test(r.out)
  })
  if (stillMarked.length || unmerged(wt).length)
    throw new DriftError('conflict markers remain', { files: [...new Set([...stillMarked, ...unmerged(wt)])] })
  const resolved = git(wt, ['write-tree'])
  const patch = git(wt, ['diff', '--no-color', c.markersTree, resolved])
  if (c.mod) {
    const rec = state.mods[c.mod]
    rec.outcome = rec.outcome === 'clean' ? 'resolved' : rec.outcome
    rec.agentTouched = true
    rec.agentPatches.push(savePatch(repo, `${c.mod}-resolve-${rec.agentPatches.length + 1}`, patch))
  }
  commitOp(state, wt, c, true)
  state.queue.shift()
  state.current = undefined
  state.status = 'applying'
  saveState(repo, state)
}
