import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DriftError, tryGit } from './git.ts'

/** What a mod promises: the user's words and how to prove the behavior survived. */
export interface Intent {
  mod: string
  request: string
  /** A shell command, `build` (unverified), or `launch [cmd]`. */
  check: string
  /** The request was back-filled by an agent during adoption, not said by the user. */
  adopted?: boolean
}

export const intentPath = (mod: string) => `.drift/mods/${mod}.md`

export function formatIntent(i: Intent): string {
  // Front matter holds one line; a silently truncated check would pass while proving nothing.
  if (/[\r\n]/.test(i.check.trim())) throw new DriftError('check must be one line; join commands with && or put them in a script')
  const front = [`mod: "${i.mod}"`, `check: ${i.check.trim()}`]
  if (i.adopted) front.push('adopted: true')
  const quoted = i.request
    .trim()
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
  return `---\n${front.join('\n')}\n---\n\n## Request\n\n${quoted}\n`
}

export function parseIntent(text: string, mod: string): Intent {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new DriftError(`${intentPath(mod)}: missing front matter`)
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  const body = m[2].replace(/^[\s\S]*?## Request\s*\n/, '')
  const request = body
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n')
    .trim()
  return { mod, request, check: fields.check || 'build', adopted: fields.adopted === 'true' }
}

export function writeIntent(root: string, i: Intent): void {
  mkdirSync(join(root, '.drift/mods'), { recursive: true })
  writeFileSync(join(root, intentPath(i.mod)), formatIntent(i))
}

export function readIntent(root: string, mod: string): Intent {
  const p = join(root, intentPath(mod))
  if (!existsSync(p)) throw new DriftError(`missing intent file ${intentPath(mod)}`)
  return parseIntent(readFileSync(p, 'utf8'), mod)
}

/** Reads a mod's intent as recorded in a commit (works without a checkout). */
export function intentAt(cwd: string, rev: string, mod: string): Intent | undefined {
  const r = tryGit(cwd, ['show', `${rev}:${intentPath(mod)}`])
  return r.ok ? parseIntent(r.out, mod) : undefined
}

export function isUnverified(check: string): boolean {
  return check.trim() === 'build' || /^launch\b/.test(check.trim())
}
