import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { type Config } from './config.ts'
import { DriftError, git, lines, revParse, trailer, tryGit } from './git.ts'

export const INIT_TRAILER = 'Drift'
export const MOD_TRAILER = 'Mod'

export interface Repo {
  /** The main working tree: the checkout the user lives in and installs from. */
  root: string
  /** Shared git dir; drift keeps sync state under <common>/drift. */
  common: string
  stateDir: string
}

export function openRepo(cwd = process.cwd()): Repo {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const first = git(cwd, ['worktree', 'list', '--porcelain']).split('\n')[0]
  const root = first.replace(/^worktree /, '')
  const stateDir = join(common, 'drift')
  mkdirSync(stateDir, { recursive: true })
  return { root, common, stateDir }
}

export function worktreePath(repo: Repo, config: Config): string {
  return config.worktree
    ? resolve(repo.root, config.worktree)
    : join(dirname(repo.root), `.${basename(repo.root)}.drift-sync`)
}

// ---- upstream -------------------------------------------------------------

export const TAG_NS = 'refs/drift/upstream/tags'
export const HEAD_NS = 'refs/drift/upstream/heads'

export function fetchUpstream(cwd: string, config: Config): void {
  const specs = [`+refs/tags/*:${TAG_NS}/*`]
  if (config.track !== 'tags') specs.push(`+refs/heads/${config.track}:${HEAD_NS}/${config.track}`)
  else {
    const head = defaultBranch(cwd, config.remote)
    if (head) specs.push(`+refs/heads/${head}:${HEAD_NS}/${head}`)
  }
  git(cwd, ['fetch', '--no-tags', '--quiet', config.remote, ...specs])
}

export function defaultBranch(cwd: string, remote: string): string | undefined {
  const r = tryGit(cwd, ['ls-remote', '--symref', remote, 'HEAD'])
  return r.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1]
}

export interface Target {
  sha: string
  ref: string
}

/** Newest upstream release tag (or the tracked branch tip). */
export function latestUpstream(cwd: string, config: Config): Target | undefined {
  if (config.track !== 'tags') {
    const r = tryGit(cwd, ['rev-parse', '--verify', `${HEAD_NS}/${config.track}^{commit}`])
    return r.ok ? { sha: r.out, ref: config.track } : undefined
  }
  const pattern = `${TAG_NS}/${config.tagPattern ?? ''}`
  const names = lines(
    git(cwd, ['for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=4)', config.tagPattern ? pattern : `${TAG_NS}/`]),
  )
  const name = names.find((n) => config.prerelease || !isPrerelease(n))
  return name ? { sha: revParse(cwd, `${TAG_NS}/${name}`), ref: name } : undefined
}

export function isPrerelease(tag: string): boolean {
  return /\d+\.\d+(\.\d+)*-/.test(tag) || /\d[.-]?(alpha|beta|rc|pre|canary|next|dev)/i.test(tag)
}

/** Resolves --to: an upstream tag name, upstream branch, or any rev. */
export function resolveUpstream(cwd: string, rev: string): Target {
  for (const candidate of [`${TAG_NS}/${rev}`, `${HEAD_NS}/${rev}`, rev]) {
    const r = tryGit(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`])
    if (r.ok) return { sha: r.out, ref: rev }
  }
  throw new DriftError(`unknown upstream revision: ${rev}`)
}

export function describeUpstream(cwd: string, sha: string): string {
  const tags = lines(git(cwd, ['for-each-ref', '--sort=-v:refname', '--points-at', sha, '--format=%(refname:strip=4)', `${TAG_NS}/`]))
  return tags[0] ?? sha.slice(0, 12)
}

// ---- the mod stack --------------------------------------------------------

export interface StackCommit {
  sha: string
  subject: string
  message: string
  /** `init` for the config commit, a mod number, or undefined for an unadopted commit. */
  mod?: string
  init: boolean
}

/** The config commit at the bottom of the stack; its parent is the pinned upstream commit. */
export function findInit(cwd: string, head = 'HEAD'): string {
  const sha = git(cwd, ['log', '--format=%H', '-n1', '-E', `--grep=^${INIT_TRAILER}: init$`, head])
  if (!sha) throw new DriftError('no "Drift: init" commit in history (run drift init)')
  return sha
}

export function stackBase(cwd: string, head = 'HEAD'): string {
  return revParse(cwd, `${findInit(cwd, head)}^`)
}

export function listStack(cwd: string, head = 'HEAD'): StackCommit[] {
  const base = stackBase(cwd, head)
  const merges = git(cwd, ['rev-list', '--merges', `${base}..${head}`])
  if (merges) throw new DriftError('the stack contains merge commits; drift needs a linear stack', { merges: lines(merges) })
  const raw = git(cwd, ['log', '--reverse', '--format=%H%x00%s%x00%B%x1e', `${base}..${head}`])
  return raw
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, message] = r.split('\x00')
      const init = trailer(message, INIT_TRAILER) === 'init'
      return { sha, subject, message, init, mod: init ? undefined : trailer(message, MOD_TRAILER) }
    })
}

export function nextModNumber(root: string): string {
  const dir = join(root, '.drift/mods')
  const nums = existsSync(dir) ? readdirSync(dir).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n)) : []
  return String(Math.max(0, ...nums) + 1).padStart(3, '0')
}

export function loadConfigAt(cwd: string, rev: string): Config | undefined {
  const r = tryGit(cwd, ['show', `${rev}:.drift/config`])
  return r.ok ? (JSON.parse(r.out) as Config) : undefined
}
