import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Flags } from './flags.ts'
import { tryGit } from './git.ts'
import { intentAt } from './mods.ts'
import { type Repo } from './repo.ts'
import { type SyncState } from './state.ts'

export type Ending = 'finished' | 'held' | 'aborted' | 'install-failed'

export interface ModReport {
  mod: string
  subject: string
  request?: string
  adopted?: boolean
  check?: string
  outcome: string
  conflicted: string[]
  agentTouched: boolean
  checkOk?: boolean
  unverified?: boolean
  flags?: Flags
  hold?: string
}

const HEADLINE: Record<Ending, string> = {
  finished: 'Synced, verified and installed.',
  held: 'Held for review. Nothing is installed yet; run `drift sync accept` or `drift sync discard`.',
  aborted: 'Aborted. The fork is exactly where it was.',
  'install-failed': 'Install failed, so the fork was put back where it was.',
}

const quote = (s: string) => s.split('\n').map((l) => `> ${l}`).join('\n')

export function modReports(repo: Repo, state: SyncState, flags: Record<string, Flags>, holds: Record<string, string>): ModReport[] {
  return Object.values(state.mods).map((m) => {
    const intent = intentAt(repo.root, m.oldSha, m.mod)
    const check = state.verified?.mods.find((c) => c.name === m.mod)
    return {
      mod: m.mod,
      subject: m.subject,
      request: intent?.request,
      adopted: intent?.adopted,
      check: intent?.check,
      outcome: m.outcome,
      conflicted: m.conflicted,
      agentTouched: m.agentTouched,
      checkOk: check?.ok,
      unverified: check?.unverified,
      flags: flags[m.mod],
      hold: holds[m.mod],
    }
  })
}

function outcomeLine(m: ModReport): string {
  const parts: string[] = []
  if (m.outcome === 'clean') parts.push('Rebased cleanly.')
  if (m.outcome === 'resolved') parts.push(`The agent re-applied it (conflicts in ${m.conflicted.map((f) => `\`${f}\``).join(', ')}).`)
  if (m.outcome === 'absorbed') parts.push('Upstream now does this; the mod was dropped (kept at `refs/drift/absorbed/' + m.mod + '`).')
  if (m.outcome === 'dropped') parts.push('Left out with `--without` (kept at `refs/drift/dropped/' + m.mod + '`).')
  if (m.agentTouched && m.outcome !== 'resolved') parts.push('The agent edited it after a failed check.')
  if (m.checkOk !== undefined)
    parts.push(m.checkOk ? (m.unverified ? `Check \`${m.check}\` passed, but it only proves the app builds or starts.` : `Check \`${m.check}\` passed.`) : `Check \`${m.check}\` failed.`)
  return parts.join(' ')
}

export function renderReport(repo: Repo, state: SyncState, ending: Ending, mods: ModReport[], reason?: string): string {
  const out: string[] = [`# drift sync: ${state.from.ref} → ${state.to.ref}`, '', HEADLINE[ending]]
  if (reason) out.push('', reason)
  const v = state.verified
  if (v) {
    const bits = [`build ${v.build.ok ? 'passed' : 'failed'}`]
    if (v.test) bits.push(`upstream tests ${v.test.ok ? 'passed' : 'failed'}`)
    out.push('', `Verify: ${bits.join(', ')}.`)
    for (const c of [v.build, v.test].filter((c) => c && !c.ok)) out.push('', '```', c!.tail ?? '', '```')
  }
  for (const m of mods) {
    out.push('', `## ${m.mod}: ${m.subject}`, '')
    if (m.request) out.push(m.adopted ? '_Request back-filled during adoption:_' : '', quote(m.request), '')
    out.push(outcomeLine(m))
    for (const o of m.flags?.overrides ?? []) {
      const commits = o.commits.map((c) => `${c.slice(0, 9)} "${tryGit(repo.root, ['log', '-1', '--format=%s', c]).out}"`).join(', ')
      out.push(`- ⚠ Replaces lines upstream changed in this release in \`${o.file}\` (${commits}). Check the request still makes sense against upstream's change.`)
    }
    for (const t of m.flags?.rewritesTests ?? []) out.push(`- ⚠ Changes upstream's own test \`${t}\`.`)
    if (m.hold) out.push(`- Held: ${m.hold}`)
    const failed = v?.mods.find((c) => c.name === m.mod && !c.ok)
    if (failed?.tail) out.push('', '```', failed.tail, '```')
    if (ending === 'held' && m.agentTouched) {
      out.push('', 'What the agent wrote:')
      for (const p of state.mods[m.mod].agentPatches) out.push('', '```diff', readFileSync(p, 'utf8').trim(), '```')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

export function saveReport(repo: Repo, text: string, json: unknown): string {
  const dir = join(repo.stateDir, 'reports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const p = join(dir, `${stamp}.md`)
  writeFileSync(p, text)
  writeFileSync(p.replace(/\.md$/, '.json'), JSON.stringify(json, null, 2))
  writeFileSync(join(dir, 'latest'), p)
  return p
}
