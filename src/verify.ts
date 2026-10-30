import { join } from 'node:path'
import { type Config } from './config.ts'
import { runLaunch, runShell, type RunResult } from './exec.ts'
import { git } from './git.ts'
import { intentAt, isUnverified, readIntent } from './mods.ts'
import { listStack } from './repo.ts'
import { type CheckResult, MAX_ATTEMPTS, type VerifyResult } from './state.ts'

/**
 * Build, run upstream tests, then each mod's check, in `cwd`.
 * `attempts` counts failed verifies per unit across a sync; it is updated in place.
 * `absorbed` mods are gone from the stack but their checks still have to pass.
 */
export async function verify(
  cwd: string,
  config: Config,
  logDir: string,
  attempts: Record<string, number>,
  absorbed: string[] = [],
): Promise<VerifyResult> {
  const result = (name: string, check: string, r: RunResult | undefined, unverified = false): CheckResult => {
    const ok = r?.ok ?? false
    if (r && !ok) attempts[name] = (attempts[name] ?? 0) + 1
    const n = attempts[name] ?? 0
    // The first failure is free; each later one follows an agent attempt.
    return { name, check, ok, unverified, attempts: n, exhausted: !ok && n > MAX_ATTEMPTS, log: r?.log, tail: ok ? undefined : r?.tail }
  }

  const build = result('build', config.build, runShell(config.build, cwd, join(logDir, 'build.log')))
  const tip = git(cwd, ['rev-parse', 'HEAD'])
  const mods: CheckResult[] = []
  if (!build.ok) return { green: false, tip, build, mods }

  const test = config.test ? result('test', config.test, runShell(config.test, cwd, join(logDir, 'test.log'))) : undefined

  const checks = listStack(cwd).flatMap((c) => (c.mod ? [{ mod: c.mod, check: readIntent(cwd, c.mod).check }] : []))
  for (const mod of absorbed) {
    const intent = intentAt(cwd, `refs/drift/absorbed/${mod}`, mod)
    if (intent) checks.push({ mod, check: intent.check })
  }
  for (const { mod, check } of checks) {
    const log = join(logDir, `mod-${mod}.log`)
    const launch = check.match(/^launch\b\s*(.*)$/)
    let r: RunResult
    if (check.trim() === 'build') r = { ok: true, code: 0, log: build.log!, tail: '' }
    else if (launch) {
      const cmd = launch[1] || config.launch
      r = cmd
        ? await runLaunch(cmd, cwd, log, config.launchWait ?? 5)
        : { ok: false, code: null, log, tail: 'check is `launch` but config has no `launch` command' }
    } else r = runShell(check, cwd, log)
    mods.push(result(mod, check, r, isUnverified(check)))
  }

  const green = build.ok && (test?.ok ?? true) && mods.every((m) => m.ok)
  return { green, tip, build, test, mods }
}
