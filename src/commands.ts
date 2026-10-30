import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { resolveCurrent, runQueue, savePatch } from './apply.ts'
import { type Config, readConfig, writeConfig } from './config.ts'
import { runShell } from './exec.ts'
import { type Flags, flagged, modFlags } from './flags.ts'
import { DriftError, git, isAncestor, isClean, lines, revParse, tryGit } from './git.ts'
import { type Intent, intentPath, isUnverified, readIntent, writeIntent } from './mods.ts'
import {
  HEAD_NS,
  type Repo,
  defaultBranch,
  describeUpstream,
  fetchUpstream,
  latestUpstream,
  listStack,
  nextModNumber,
  openRepo,
  resolveUpstream,
  stackBase,
  worktreePath,
} from './repo.ts'
import { type Ending, modReports, renderReport, saveReport } from './report.ts'
import { rewriteStack, snapshotCommit } from './rewrite.ts'
import { MAX_ATTEMPTS, type SyncState, clearState, loadState, requireState, saveState } from './state.ts'
import { verify } from './verify.ts'

/** Exit codes: 0 ok, 1 refused or red, 2 conflict for the agent, 3 held for review. */
export interface Result {
  code: number
  json: Record<string, unknown>
}

const ok = (json: Record<string, unknown>): Result => ({ code: 0, json })

function requireClean(repo: Repo) {
  if (!isClean(repo.root)) throw new DriftError('the working tree has uncommitted changes')
}

function requireNoSync(repo: Repo) {
  const s = loadState(repo)
  if (s) throw new DriftError(`a sync is in progress (${s.status}); continue, finish or abort it first`)
}

function addTrailer(cwd: string, message: string, mod: string): string {
  return git(cwd, ['interpret-trailers', '--if-exists', 'replace', '--trailer', `Mod: ${mod}`], message.trim() + '\n')
}

// ---- init / adopt / mods --------------------------------------------------

export interface InitOptions {
  upstream: string
  remote?: string
  track?: string
  tagPattern?: string
  base?: string
  build: string
  test?: string
  install?: string
  launch?: string
}

export function init(o: InitOptions): Result {
  const repo = openRepo()
  if (tryGit(repo.root, ['cat-file', '-e', 'HEAD:.drift/config']).ok) throw new DriftError('already a drift repo')
  requireClean(repo)
  const remote = o.remote ?? 'upstream'
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) throw new DriftError(`invalid remote name: ${remote}`)
  const existing = tryGit(repo.root, ['remote', 'get-url', remote])
  if (!existing.ok) git(repo.root, ['remote', 'add', '--', remote, o.upstream])
  else if (existing.out !== o.upstream) throw new DriftError(`remote ${remote} points at ${existing.out}; pass --remote <name>`)

  const config: Config = {
    upstream: o.upstream,
    remote,
    track: o.track ?? 'tags',
    ...(o.tagPattern && { tagPattern: o.tagPattern }),
    pinned: { sha: '', ref: '' },
    build: o.build,
    ...(o.test && { test: o.test }),
    ...(o.install && { install: o.install }),
    ...(o.launch && { launch: o.launch }),
    unattended: { resolved_unverified: 'hold', flagged: 'hold' },
  }
  fetchUpstream(repo.root, config)
  let base = o.base && revParse(repo.root, o.base)
  if (!base) {
    const branch = config.track === 'tags' ? defaultBranch(repo.root, remote) : config.track
    const mb = branch && tryGit(repo.root, ['merge-base', 'HEAD', `${HEAD_NS}/${branch}`])
    if (!mb || !mb.ok) throw new DriftError('cannot find where this fork leaves upstream; pass --base <rev>')
    base = mb.out
  }
  config.pinned = { sha: base, ref: describeUpstream(repo.root, base) }

  const ahead = lines(git(repo.root, ['rev-list', '--reverse', `${base}..HEAD`]))
  if (lines(git(repo.root, ['rev-list', '--merges', `${base}..HEAD`])).length)
    throw new DriftError('the commits ahead of upstream include merges; linearize them first')
  const tip = rewriteStack(repo, base, [
    { edit: (wt) => writeConfig(wt, config), message: 'drift: init\n\nDrift: init' },
    ...ahead.map((sha) => ({ sha })),
  ])
  git(repo.root, ['reset', '--quiet', '--keep', tip])
  return ok({ status: 'initialized', ...stackJson(repo) })
}

function stackJson(repo: Repo) {
  const config = readConfig(repo.root)
  const stack = listStack(repo.root)
  return {
    pinned: config.pinned,
    mods: stack
      .filter((c) => c.mod)
      .map((c) => {
        const { check, adopted } = readIntent(repo.root, c.mod!)
        return { mod: c.mod, subject: c.subject, sha: c.sha, check, unverified: isUnverified(check), ...(adopted && { adopted }) }
      }),
    unadopted: stack
      .filter((c) => !c.mod && !c.init)
      .map((c) => ({ sha: c.sha, subject: c.subject, files: lines(git(repo.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', c.sha])) })),
  }
}

/** Adds a Mod trailer and a back-filled intent file to an existing commit ahead of upstream. */
export function adopt(rev: string, request: string, check: string): Result {
  const repo = openRepo()
  requireClean(repo)
  requireNoSync(repo)
  const sha = revParse(repo.root, rev)
  const stack = listStack(repo.root)
  const i = stack.findIndex((c) => c.sha === sha)
  if (i < 0) throw new DriftError(`${rev} is not in the stack ahead of upstream`)
  if (stack[i].mod || stack[i].init) throw new DriftError(`${rev} is already part of drift`)
  const mod = nextModNumber(repo.root)
  const intent: Intent = { mod, request, check, adopted: true }
  const tip = rewriteStack(repo, `${sha}^`, [
    { sha, edit: (wt) => writeIntent(wt, intent), message: addTrailer(repo.root, stack[i].message, mod) },
    ...stack.slice(i + 1).map((c) => ({ sha: c.sha })),
  ])
  git(repo.root, ['reset', '--quiet', '--keep', tip])
  return ok({ status: 'adopted', mod, intent_path: intentPath(mod), ...stackJson(repo) })
}

export function modCommit(request: string, check: string, subject?: string): Result {
  const repo = openRepo()
  readConfig(repo.root)
  if (isClean(repo.root)) throw new DriftError('nothing to commit: make the change first')
  const mod = nextModNumber(repo.root)
  writeIntent(repo.root, { mod, request, check })
  git(repo.root, ['add', '-A'])
  const title = subject ?? request.split('\n')[0].slice(0, 72)
  git(repo.root, ['commit', '--quiet', '-m', `${title}\n\nMod: ${mod}`])
  return ok({ status: 'committed', mod, sha: git(repo.root, ['rev-parse', 'HEAD']), intent_path: intentPath(mod) })
}

/** Folds working-tree changes (and optionally a new request or check) into an existing mod. */
export function modAmend(mod: string, request?: string, check?: string): Result {
  const repo = openRepo()
  requireNoSync(repo)
  const stack = listStack(repo.root)
  const i = stack.findIndex((c) => c.mod === mod)
  if (i < 0) throw new DriftError(`no mod ${mod} in the stack`)
  const old = readIntent(repo.root, mod)
  const intent: Intent = {
    ...old,
    request: request ?? old.request,
    check: check ?? old.check,
    adopted: request ? false : old.adopted,
  }
  const dirty = !isClean(repo.root)
  const fix = dirty ? snapshotCommit(repo, `amend ${mod}`) : undefined
  const edit = (wt: string) => writeIntent(wt, intent)
  const tip = rewriteStack(repo, `${stack[i].sha}^`, [
    { sha: stack[i].sha, ...(!fix && { edit }) },
    ...(fix ? [{ sha: fix, squash: true, edit }] : []),
    ...stack.slice(i + 1).map((c) => ({ sha: c.sha })),
  ])
  // The rewritten stack must contain exactly what the checkout had, apart from the intent file.
  const expected = fix ?? 'HEAD'
  const diff = lines(git(repo.root, ['diff', '--name-only', expected, tip])).filter((f) => f !== intentPath(mod))
  if (diff.length) throw new DriftError('amending would change other files; nothing was changed', { files: diff })
  git(repo.root, ['reset', '--quiet', '--hard', tip])
  return ok({ status: 'amended', mod, sha: git(repo.root, ['rev-parse', 'HEAD']), intent_path: intentPath(mod) })
}

const CONFIG_KEYS = ['build', 'test', 'install', 'launch', 'launchWait', 'track', 'tagPattern', 'prerelease', 'worktree', 'tests', 'unattended.resolved_unverified', 'unattended.flagged']

/** Changes a config value by rewriting the init commit at the bottom of the stack. */
export function configSet(key: string, value: string): Result {
  const repo = openRepo()
  requireClean(repo)
  requireNoSync(repo)
  if (!CONFIG_KEYS.includes(key)) throw new DriftError(`unknown config key ${key}; one of ${CONFIG_KEYS.join(', ')}`)
  const parsed: unknown = ['launchWait', 'prerelease', 'tests'].includes(key) ? JSON.parse(value) : value
  const stack = listStack(repo.root)
  const edit = (wt: string) => {
    const c = readConfig(wt)
    const [k, sub] = key.split('.')
    if (sub) (c.unattended as unknown as Record<string, unknown>)[sub] = parsed
    else if (value === '') delete (c as unknown as Record<string, unknown>)[k]
    else (c as unknown as Record<string, unknown>)[k] = parsed
    writeConfig(wt, c)
  }
  const tip = rewriteStack(repo, stackBase(repo.root), [{ sha: stack[0].sha, edit }, ...stack.slice(1).map((c) => ({ sha: c.sha }))])
  git(repo.root, ['reset', '--quiet', '--keep', tip])
  return ok({ status: 'configured', config: readConfig(repo.root) })
}

export function status(fetch: boolean): Result {
  const repo = openRepo()
  const config = readConfig(repo.root)
  if (fetch) fetchUpstream(repo.root, config)
  const base = stackBase(repo.root)
  const latest = latestUpstream(repo.root, config)
  const s = loadState(repo)
  return ok({
    ...stackJson(repo),
    base,
    latest,
    behind: !!latest && latest.sha !== base && isAncestor(repo.root, base, latest.sha),
    ...(s && { sync: { status: s.status, from: s.from.ref, to: s.to.ref, worktree: s.worktree } }),
  })
}

// ---- sync -----------------------------------------------------------------

export interface StartOptions {
  to?: string
  without: string[]
  unattended: boolean
}

export function syncStart(o: StartOptions): Result {
  const repo = openRepo()
  const config = readConfig(repo.root)
  requireNoSync(repo)
  requireClean(repo)
  const stack = listStack(repo.root)
  const unadopted = stack.filter((c) => !c.mod && !c.init)
  if (unadopted.length)
    throw new DriftError('commits ahead of upstream have no Mod trailer; adopt them first', {
      unadopted: unadopted.map((c) => ({ sha: c.sha, subject: c.subject })),
    })
  const unknown = o.without.filter((m) => !stack.some((c) => c.mod === m))
  if (unknown.length) throw new DriftError(`--without names unknown mods: ${unknown.join(', ')}`)

  fetchUpstream(repo.root, config)
  const base = stackBase(repo.root)
  const from = { sha: base, ref: describeUpstream(repo.root, base) }
  const to = o.to ? resolveUpstream(repo.root, o.to) : latestUpstream(repo.root, config)
  if (!to) throw new DriftError('no upstream release found')
  if (to.sha === base && !o.without.length) return ok({ status: 'current', pinned: from })
  if (!o.to && !isAncestor(repo.root, base, to.sha)) throw new DriftError(`latest upstream ${to.ref} is not ahead of ${from.ref}`)

  const wt = worktreePath(repo, config)
  claimWorktree(repo, wt)
  git(repo.root, ['worktree', 'add', '--quiet', '--detach', wt, to.sha])
  writeFileSync(join(git(wt, ['rev-parse', '--absolute-git-dir']), DRIFT_MARKER), '')
  const checkpoint = git(repo.root, ['rev-parse', 'HEAD'])
  git(repo.root, ['update-ref', 'refs/drift/checkpoint', checkpoint])

  const state: SyncState = {
    status: 'applying',
    startedAt: new Date().toISOString(),
    checkpoint,
    branch: tryGit(repo.root, ['symbolic-ref', '--short', 'HEAD']).out,
    from,
    to,
    worktree: wt,
    without: o.without,
    unattended: o.unattended,
    queue: [],
    mods: {},
    attempts: {},
  }
  for (const c of stack) {
    if (c.init) {
      state.queue.push({ sha: c.sha, init: true })
      continue
    }
    const mod = c.mod!
    const dropped = o.without.includes(mod)
    state.mods[mod] = { mod, subject: c.subject, oldSha: c.sha, outcome: dropped ? 'dropped' : 'clean', conflicted: [], agentTouched: false, agentPatches: [] }
    if (dropped) git(repo.root, ['update-ref', `refs/drift/dropped/${mod}`, c.sha])
    else state.queue.push({ sha: c.sha, mod })
  }
  saveState(repo, state)
  return queueResult(runQueue(repo, state))
}

/** Clears a stale sync worktree, refusing any path drift doesn't own. */
function claimWorktree(repo: Repo, wt: string) {
  const rel = relative(repo.root, wt)
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new DriftError(`worktree path ${wt} is inside the repo`)
  if (!existsSync(wt)) return
  const ours = git(repo.root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .some((l) => l === `worktree ${wt}`)
  const marked = ours && existsSync(join(tryGit(wt, ['rev-parse', '--absolute-git-dir']).out, DRIFT_MARKER))
  if (!marked) throw new DriftError(`worktree path ${wt} already exists and is not a drift worktree; move it or set worktree in config`)
  git(repo.root, ['worktree', 'remove', '--force', wt])
}

/** Written into the admin dir of worktrees drift creates, so it never removes anyone else's. */
const DRIFT_MARKER = 'drift-sync'

function queueResult(r: ReturnType<typeof runQueue>): Result {
  return { code: r.status === 'conflict' ? 2 : 0, json: { ...r } }
}

export function syncContinue(): Result {
  const repo = openRepo()
  const state = requireState(repo)
  if (state.status === 'conflict') resolveCurrent(repo, state)
  else if (state.status !== 'applying') throw new DriftError(`nothing to continue (sync is ${state.status})`)
  return queueResult(runQueue(repo, state))
}

/** Folds the agent's edits in the sync worktree into mod NNN after a failed check. */
export function syncFixup(mod: string): Result {
  const repo = openRepo()
  const state = requireState(repo)
  if (state.status !== 'applied') throw new DriftError(`fixups apply after the stack is rebuilt (sync is ${state.status})`)
  const wt = state.worktree
  const rec = state.mods[mod]
  if (!rec) throw new DriftError(`no mod ${mod} in this sync`)
  if ((state.attempts[mod] ?? 0) > MAX_ATTEMPTS) throw new DriftError(`mod ${mod} has used its ${MAX_ATTEMPTS} attempts; abort the sync`)
  const stack = listStack(wt)
  const i = stack.findIndex((c) => c.mod === mod)
  if (i < 0) throw new DriftError(`mod ${mod} is not in the rebuilt stack`)
  git(wt, ['add', '-A'])
  if (!git(wt, ['diff', '--cached', '--name-only'])) throw new DriftError('no changes in the sync worktree to fold in')
  git(wt, ['commit', '--quiet', '--no-verify', '-m', `drift fixup ${mod}`])
  const fix = git(wt, ['rev-parse', 'HEAD'])
  rec.agentTouched = true
  rec.agentPatches.push(savePatch(repo, `${mod}-fixup-${rec.agentPatches.length + 1}`, git(wt, ['show', '--no-color', '--format=', fix])))
  git(wt, ['reset', '--quiet', '--hard', stack[i].sha])
  state.queue = [{ sha: fix, mod, squash: true }, ...stack.slice(i + 1).map((c) => ({ sha: c.sha, mod: c.mod }))]
  state.status = 'applying'
  state.verified = undefined
  saveState(repo, state)
  return queueResult(runQueue(repo, state))
}

export async function verifyCmd(): Promise<Result> {
  const repo = openRepo()
  const state = loadState(repo)
  if (!state) {
    const r = await verify(repo.root, readConfig(repo.root), join(repo.stateDir, 'logs'), {})
    return { code: r.green ? 0 : 1, json: { ...r } }
  }
  if (state.status !== 'applied') throw new DriftError(`cannot verify while the sync is ${state.status}`)
  // A green result is bound to a commit, so the files it tested must be exactly that commit.
  if (!isClean(state.worktree)) throw new DriftError('the sync worktree has uncommitted changes; fold them into a mod with drift sync fixup NNN, then verify')
  const config = readConfig(state.worktree)
  state.verified = await verify(state.worktree, config, join(repo.stateDir, 'logs'), state.attempts)
  saveState(repo, state)
  const exhausted = [state.verified.build, state.verified.test, ...state.verified.mods].filter((c) => c && !c.ok && c.exhausted).map((c) => c!.name)
  return {
    code: state.verified.green ? 0 : 1,
    json: { ...state.verified, ...(exhausted.length && { exhausted, next: 'abort' }) },
  }
}

function computeFlags(repo: Repo, state: SyncState, config: Config): Record<string, Flags> {
  const flags: Record<string, Flags> = {}
  for (const c of listStack(state.worktree)) {
    if (!c.mod) continue
    const f = modFlags(state.worktree, c.sha, state.from.sha, state.to.sha, config.tests)
    if (flagged(f)) flags[c.mod] = f
  }
  return flags
}

function holdReasons(state: SyncState, config: Config, flags: Record<string, Flags>): Record<string, string> {
  const holds: Record<string, string> = {}
  for (const m of Object.values(state.mods)) {
    if (!m.agentTouched) continue
    const check = state.verified?.mods.find((c) => c.name === m.mod)
    if (check?.unverified && config.unattended.resolved_unverified === 'hold')
      holds[m.mod] = `the agent re-applied it and its check (\`${check.check}\`) cannot prove the behavior survived.`
    else if (flags[m.mod] && config.unattended.flagged === 'hold')
      holds[m.mod] = 'the agent re-applied it over upstream changes or upstream tests.'
  }
  return holds
}

function report(repo: Repo, state: SyncState, ending: Ending, flags: Record<string, Flags>, holds: Record<string, string>, reason?: string) {
  const mods = modReports(repo, state, flags, holds)
  const text = renderReport(repo, state, ending, mods, reason)
  return saveReport(repo, text, { ending, from: state.from, to: state.to, reason, verify: state.verified, mods })
}

function cleanup(repo: Repo, state: SyncState) {
  tryGit(state.worktree, ['cherry-pick', '--abort'])
  tryGit(repo.root, ['worktree', 'remove', '--force', state.worktree])
  rmSync(state.worktree, { recursive: true, force: true })
  tryGit(repo.root, ['worktree', 'prune'])
  for (const ref of ['refs/drift/checkpoint', 'refs/drift/pending']) tryGit(repo.root, ['update-ref', '-d', ref])
  clearState(repo)
}

export function syncFinish(unattended: boolean): Result {
  const repo = openRepo()
  const state = requireState(repo)
  if (state.status === 'held') throw new DriftError('this sync is held; run drift sync accept or drift sync discard')
  if (state.status !== 'applied') throw new DriftError(`cannot finish while the sync is ${state.status}`)
  const tip = git(state.worktree, ['rev-parse', 'HEAD'])
  const v = state.verified
  if (!v || v.tip !== tip) throw new DriftError('run drift verify on the current stack first')
  if (!v.green) throw new DriftError('verify is red; fix the failing mod with drift sync fixup, or abort', { failing: [v.build, v.test, ...v.mods].filter((c) => c && !c.ok).map((c) => c!.name) })
  if (!isClean(state.worktree)) throw new DriftError('the sync worktree has uncommitted changes; fold them in with drift sync fixup')

  const config = readConfig(state.worktree)
  const flags = computeFlags(repo, state, config)
  const holds = unattended || state.unattended ? holdReasons(state, config, flags) : {}
  if (Object.keys(holds).length) {
    git(repo.root, ['update-ref', 'refs/drift/pending', tip])
    state.status = 'held'
    saveState(repo, state)
    const path = report(repo, state, 'held', flags, holds)
    return { code: 3, json: { status: 'held', pending: tip, holds, report: path, worktree: state.worktree } }
  }
  return land(repo, state, flags, tip)
}

/** Moves the user's branch to the verified stack, builds and installs; restores everything on failure. */
function land(repo: Repo, state: SyncState, flags: Record<string, Flags>, tip: string): Result {
  const head = git(repo.root, ['rev-parse', 'HEAD'])
  if (head !== state.checkpoint) throw new DriftError('HEAD moved since the sync started; abort and start again')
  const branch = tryGit(repo.root, ['symbolic-ref', '--short', 'HEAD']).out
  if (branch !== state.branch) throw new DriftError(`the sync started on ${state.branch || 'a detached HEAD'} but ${branch || 'a detached HEAD'} is checked out; switch back first`)
  requireClean(repo)
  git(repo.root, ['reset', '--quiet', '--keep', tip])
  const logs = join(repo.stateDir, 'logs')
  // Build and install as the landed commit says, not as anything left in a worktree says.
  const landed = readConfig(repo.root)
  const steps = [landed.build, landed.install].filter((c): c is string => !!c)
  for (const [n, cmd] of steps.entries()) {
    const r = runShell(cmd, repo.root, join(logs, `land-${n}.log`))
    if (!r.ok) {
      // The checkout was clean before landing, so anything tracked that changed came from the landing commands.
      const restored = tryGit(repo.root, ['reset', '--quiet', '--hard', state.checkpoint])
      if (restored.ok) {
        const old = readConfig(repo.root)
        for (const [k, c] of [old.build, old.install].filter((c): c is string => !!c).entries()) runShell(c, repo.root, join(logs, `restore-${k}.log`))
      }
      let reason = `\`${cmd}\` failed in ${repo.root}:\n\n\`\`\`\n${r.tail}\n\`\`\``
      if (!restored.ok) reason += `\n\nResetting to the checkpoint ${state.checkpoint} also failed:\n\n\`\`\`\n${restored.out}\n\`\`\``
      const path = report(repo, state, 'install-failed', flags, {}, reason)
      cleanup(repo, state)
      return { code: 1, json: { status: 'install-failed', command: cmd, tail: r.tail, restored: restored.ok, report: path } }
    }
  }
  const path = report(repo, state, 'finished', flags, {})
  cleanup(repo, state)
  return ok({ status: 'finished', pinned: { sha: state.to.sha, ref: state.to.ref }, head: tip, report: path, flagged: Object.keys(flags) })
}

export function syncAccept(): Result {
  const repo = openRepo()
  const state = requireState(repo)
  if (state.status !== 'held') throw new DriftError('no held sync to accept')
  const config = readConfig(state.worktree)
  return land(repo, state, computeFlags(repo, state, config), git(repo.root, ['rev-parse', 'refs/drift/pending']))
}

/** Always safe: the user's checkout is never touched before finish, so this only removes sync state. */
export function syncAbort(reason?: string): Result {
  const repo = openRepo()
  const state = loadState(repo)
  if (!state) return ok({ status: 'idle' })
  const path = report(repo, state, 'aborted', {}, {}, reason)
  cleanup(repo, state)
  return ok({ status: 'aborted', head: git(repo.root, ['rev-parse', 'HEAD']), report: path })
}

export function syncDiscard(): Result {
  const repo = openRepo()
  const state = requireState(repo)
  if (state.status !== 'held') throw new DriftError('no held sync to discard')
  return syncAbort('The held result was discarded.')
}

export function latestReport(): Result {
  const repo = openRepo()
  const latest = join(repo.stateDir, 'reports/latest')
  if (!existsSync(latest)) throw new DriftError('no sync report yet')
  const path = readFileSync(latest, 'utf8').trim()
  return ok({ report: path, text: readFileSync(path, 'utf8') })
}
