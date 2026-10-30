import { DEFAULT_TESTS } from './config.ts'
import { git, lines, paths, tryGit } from './git.ts'

export interface Flags {
  /** Lines this mod replaces that upstream changed in from..to. */
  overrides: { file: string; commits: string[] }[]
  /** Upstream-authored test lines this mod changes or deletes. */
  rewritesTests: string[]
}

interface Range {
  start: number
  count: number
}

/** Line ranges of `parent` that the commit deletes or replaces. */
function removedRanges(cwd: string, parent: string, sha: string, file: string): Range[] {
  const diff = git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', parent, sha, '--', file])
  const out: Range[] = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10)
    if (count > 0) out.push({ start: parseInt(m[1], 10), count })
  }
  return out
}

function blameCommits(cwd: string, rev: string, file: string, r: Range): string[] {
  const out = git(cwd, ['blame', '--porcelain', '-L', `${r.start},+${r.count}`, rev, '--', file])
  return [...new Set([...out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)].map((m) => m[1]))]
}

/**
 * Flags a rebased mod for review: it replaces lines upstream changed in this
 * release, or it edits upstream's own tests. Both make a green verify weaker evidence.
 */
export function modFlags(cwd: string, sha: string, from: string, to: string, testSpecs = DEFAULT_TESTS): Flags {
  const parent = `${sha}^`
  const released = new Set(lines(git(cwd, ['rev-list', `${from}..${to}`])))
  const modOwned = new Set(lines(git(cwd, ['rev-list', `${to}..${parent}`])))
  const tests = new Set(paths(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=MDT', parent, sha, '--', ...testSpecs]))
  const flags: Flags = { overrides: [], rewritesTests: [] }

  // --no-renames throughout: a moved file must count as deleting every line it had.
  // T too: a file replaced by a symlink loses every line it had.
  for (const file of paths(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=MDT', parent, sha])) {
    if (file.startsWith('.drift/')) continue
    if (!tryGit(cwd, ['cat-file', '-e', `${to}:${file}`]).ok) continue
    const commits = removedRanges(cwd, parent, sha, file).flatMap((r) => blameCommits(cwd, parent, file, r))
    const upstreamOwned = commits.filter((c) => !modOwned.has(c))
    const fromRelease = upstreamOwned.filter((c) => released.has(c))
    if (fromRelease.length) flags.overrides.push({ file, commits: [...new Set(fromRelease)] })
    if (tests.has(file) && upstreamOwned.length) flags.rewritesTests.push(file)
  }
  return flags
}

export const flagged = (f: Flags) => f.overrides.length > 0 || f.rewritesTests.length > 0
