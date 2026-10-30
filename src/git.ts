import { execFileSync, spawnSync } from 'node:child_process'

export class DriftError extends Error {
  readonly detail: Record<string, unknown>
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.detail = detail
  }
}

let identity: NodeJS.ProcessEnv | undefined

// Commits made by drift (rebuilt stacks, config pins) need a committer even on a bare CI runner.
function env(): NodeJS.ProcessEnv {
  if (!identity) {
    const configured = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' }).stdout?.trim()
    identity = configured
      ? {}
      : {
          GIT_AUTHOR_NAME: 'drift',
          GIT_AUTHOR_EMAIL: 'drift@localhost',
          GIT_COMMITTER_NAME: 'drift',
          GIT_COMMITTER_EMAIL: 'drift@localhost',
        }
  }
  return { ...identity, ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' }
}

export function git(cwd: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env: { ...env(), ...extraEnv },
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).replace(/\n$/, '')
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string }
    throw new DriftError(`git ${args.join(' ')} failed: ${(err.stderr || err.stdout || '').trim()}`)
  }
}

/** Runs git and reports success instead of throwing. */
export function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** Runs a git command that lists paths, NUL-delimited so no path is quoted or escaped. */
export function paths(cwd: string, args: string[]): string[] {
  return git(cwd, [args[0], '-z', ...args.slice(1)]).split('\0').filter(Boolean)
}

export function lines(s: string): string[] {
  return s.split('\n').filter(Boolean)
}

export function revParse(cwd: string, rev: string): string {
  return git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`])
}

export function isAncestor(cwd: string, a: string, b: string): boolean {
  return tryGit(cwd, ['merge-base', '--is-ancestor', a, b]).ok
}

export function isClean(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=normal']) === ''
}

export function trailer(message: string, key: string): string | undefined {
  const m = message.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'))
  return m?.[1].trim()
}
