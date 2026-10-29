import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DriftError, git, tryGit } from './git.ts'
import { type Repo } from './repo.ts'

export interface RewriteOp {
  /** Commit to pick; omit to create a new commit from `edit` alone. */
  sha?: string
  /** Squash this commit into the one below it instead of picking it. */
  squash?: boolean
  /** Edit files in the scratch worktree after the pick; changes are folded into the commit. */
  edit?: (wt: string) => void
  /** Replace the commit message. */
  message?: string
}

/**
 * Rebuilds a stack on `base` in a scratch worktree and returns the new tip.
 * For local rewrites (init, adopt, amend) that should never conflict; if one
 * does, nothing is changed and the caller gets an error.
 */
export function rewriteStack(repo: Repo, base: string, ops: RewriteOp[]): string {
  const wt = join(repo.stateDir, 'rewrite')
  tryGit(repo.root, ['worktree', 'remove', '--force', wt])
  rmSync(wt, { recursive: true, force: true })
  git(repo.root, ['worktree', 'add', '--quiet', '--detach', wt, base])
  try {
    for (const op of ops) {
      if (op.sha) {
        const r = tryGit(wt, ['cherry-pick', '--no-commit', '--allow-empty', op.sha])
        if (!r.ok) throw new DriftError(`rewriting the stack conflicted at ${op.sha.slice(0, 12)}; nothing was changed`, { output: r.out })
      }
      op.edit?.(wt)
      git(wt, ['add', '-A'])
      const msg = op.message !== undefined ? ['-m', op.message] : op.squash || !op.sha ? ['--no-edit'] : ['-C', op.sha]
      git(wt, ['commit', '--quiet', '--no-verify', '--allow-empty', ...(op.squash ? ['--amend'] : []), ...msg])
      tryGit(wt, ['cherry-pick', '--quit'])
    }
    return git(wt, ['rev-parse', 'HEAD'])
  } finally {
    tryGit(repo.root, ['worktree', 'remove', '--force', wt])
    rmSync(wt, { recursive: true, force: true })
  }
}

/** Snapshot of the main checkout (tracked and untracked) as a commit on HEAD. */
export function snapshotCommit(repo: Repo, message: string): string {
  const index = join(repo.stateDir, 'amend.index')
  rmSync(index, { force: true })
  const env = { GIT_INDEX_FILE: index }
  git(repo.root, ['read-tree', 'HEAD'], undefined, env)
  git(repo.root, ['add', '-A'], undefined, env)
  const tree = git(repo.root, ['write-tree'], undefined, env)
  rmSync(index, { force: true })
  return git(repo.root, ['commit-tree', tree, '-p', 'HEAD', '-m', message])
}
