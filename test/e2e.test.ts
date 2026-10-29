import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin/drift')
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function sh(cwd: string, cmd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('sh', ['-c', cmd], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' }).trim()
}

function drift(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  const r = spawnSync(BIN, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8', input })
  let json: any
  try {
    json = JSON.parse(r.stdout)
  } catch {
    throw new Error(`drift ${args.join(' ')} printed non-JSON:\n${r.stdout}\n${r.stderr}`)
  }
  return { code: r.status, json }
}

function write(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), text)
}

const GREET_V1 = `module.exports.greet = (name) => 'Hello, ' + name\n`
const GREET_V11 = 'module.exports.greet = (name) => `Hello, ${name}!`\n'
const TEST = (expect: string) => `const assert = require('assert')\nassert.equal(require('../greet.js').greet('a'), ${JSON.stringify(expect)})\n`

/**
 * Upstream: v1.0.0, then v1.1.0 (changes greet and its test), then v1.2.0-rc.1 (prerelease).
 * Fork: at v1.0.0 with one untrailered hack that upper-cases names (and edits upstream's test).
 */
function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'drift-e2e-'))
  const up = join(root, 'upstream')
  mkdirSync(up)
  sh(up, 'git init -q -b main')
  write(up, 'greet.js', GREET_V1)
  write(up, 'test/greet.test.js', TEST('Hello, a'))
  write(up, 'README', 'upstream\n')
  sh(up, 'git add -A && git commit -qm v1 && git tag v1.0.0')
  write(up, 'greet.js', GREET_V11)
  write(up, 'test/greet.test.js', TEST('Hello, a!'))
  write(up, 'farewell.js', 'module.exports.bye = () => "bye"\n')
  sh(up, 'git add -A && git commit -qm "punctuate greetings" && git tag -a v1.1.0 -m v1.1.0')
  write(up, 'README', 'upstream rc\n')
  sh(up, 'git commit -qam rc && git tag v1.2.0-rc.1')

  const fork = join(root, 'fork')
  sh(root, `git clone -q ${up} fork && cd fork && git reset -q --hard v1.0.0`)
  write(fork, 'greet.js', `module.exports.greet = (name) => 'Hello, ' + name.toUpperCase()\n`)
  write(fork, 'test/greet.test.js', TEST('Hello, A'))
  sh(fork, 'git commit -qam "shout names"')
  const install = join(root, 'installed')
  mkdirSync(install)
  return { root, up, fork, install, env: { INSTALL_DIR: install } }
}

function initAndAdopt(s: ReturnType<typeof scenario>, check: string) {
  const i = drift(s.fork, ['init', '--upstream', s.up, '--build', 'node -e "require(\'./greet.js\')"', '--test', 'node test/greet.test.js', '--install', 'cp greet.js "$INSTALL_DIR/"'])
  assert.equal(i.code, 0, JSON.stringify(i.json))
  assert.equal(i.json.pinned.ref, 'v1.0.0')
  assert.equal(i.json.unadopted.length, 1)
  const a = drift(s.fork, ['adopt', i.json.unadopted[0].sha, '--request-file', '-', '--check', check], {}, 'Shout the name when greeting.')
  assert.equal(a.code, 0, JSON.stringify(a.json))
  assert.equal(a.json.mod, '001')
  assert.equal(a.json.unadopted.length, 0)
  write(s.fork, 'shout.js', 'console.log(require("./greet.js").greet("x"))\n')
  const m = drift(s.fork, ['mod', 'commit', '--request', 'Add a shout script.', '--check', 'node shout.js', '-m', 'Add shout script'])
  assert.equal(m.code, 0, JSON.stringify(m.json))
  assert.equal(m.json.mod, '002')
}

/** What the agent would write: keep upstream's punctuation and the mod's upper-casing. */
function resolve(wt: string) {
  write(wt, 'greet.js', 'module.exports.greet = (name) => `Hello, ${name.toUpperCase()}!`\n')
  write(wt, 'test/greet.test.js', TEST('Hello, A!'))
}

const CHECK = `node -e "require('assert')(require('./greet.js').greet('bob').includes('BOB'))"`

test('conflict, resolve, verify, finish installs and moves the pin', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const head0 = sh(s.fork, 'git rev-parse HEAD')

  const start = drift(s.fork, ['sync', 'start'], s.env)
  assert.equal(start.code, 2, JSON.stringify(start.json))
  assert.equal(start.json.mod, '001')
  assert.equal(start.json.to, 'v1.1.0', 'prerelease tags are skipped')
  assert.deepEqual(start.json.conflicted_files.sort(), ['greet.js', 'test/greet.test.js'])
  assert.ok(existsSync(start.json.intent_path))

  const early = drift(s.fork, ['sync', 'continue'], s.env)
  assert.equal(early.code, 1, 'continue refuses while conflict markers remain')

  resolve(start.json.worktree)
  const cont = drift(s.fork, ['sync', 'continue'], s.env)
  assert.equal(cont.code, 0, JSON.stringify(cont.json))
  assert.equal(cont.json.status, 'applied')
  assert.equal(sh(s.fork, 'git rev-parse HEAD'), head0, 'the user checkout is untouched mid-sync')

  const v = drift(s.fork, ['verify'], s.env)
  assert.equal(v.code, 0, JSON.stringify(v.json))
  assert.deepEqual(v.json.mods.map((m: any) => [m.name, m.ok, m.unverified]), [['001', true, false], ['002', true, false]])

  const f = drift(s.fork, ['sync', 'finish'], s.env)
  assert.equal(f.code, 0, JSON.stringify(f.json))
  assert.equal(f.json.pinned.ref, 'v1.1.0')
  assert.deepEqual(f.json.flagged, ['001'])
  assert.match(readFileSync(join(s.install, 'greet.js'), 'utf8'), /toUpperCase\(\)\}!/)
  assert.equal(sh(s.fork, 'git rev-parse HEAD~3'), sh(s.fork, 'git rev-parse v1.1.0^{commit}'))
  assert.match(sh(s.fork, 'cat .drift/config'), /"ref": "v1.1.0"/)
  assert.ok(!existsSync(start.json.worktree))

  const report = readFileSync(f.json.report, 'utf8')
  assert.match(report, /> Shout the name when greeting\./)
  assert.match(report, /Replaces lines upstream changed in this release in `greet.js`/)
  assert.match(report, /Changes upstream's own test `test\/greet.test.js`/)

  const again = drift(s.fork, ['sync', 'start'], s.env)
  assert.equal(again.json.status, 'current')
})

test('abort always returns to the checkpoint', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const head0 = sh(s.fork, 'git rev-parse HEAD')
  const start = drift(s.fork, ['sync', 'start'], s.env)
  assert.equal(start.code, 2)
  const a = drift(s.fork, ['sync', 'abort', '--reason', 'testing'], s.env)
  assert.equal(a.code, 0)
  assert.equal(a.json.head, head0)
  assert.ok(!existsSync(start.json.worktree))
  assert.equal(drift(s.fork, ['status', '--offline']).json.sync, undefined)
})

test('unattended: an agent-resolved mod with only a build check is held, then accepted', () => {
  const s = scenario()
  initAndAdopt(s, 'build')
  const head0 = sh(s.fork, 'git rev-parse HEAD')
  const start = drift(s.fork, ['sync', 'start', '--unattended'], s.env)
  resolve(start.json.worktree)
  assert.equal(drift(s.fork, ['sync', 'continue'], s.env).code, 0)
  assert.equal(drift(s.fork, ['verify'], s.env).code, 0)
  const f = drift(s.fork, ['sync', 'finish'], s.env)
  assert.equal(f.code, 3, JSON.stringify(f.json))
  assert.deepEqual(Object.keys(f.json.holds), ['001'])
  assert.equal(sh(s.fork, 'git rev-parse refs/drift/pending'), f.json.pending)
  assert.equal(sh(s.fork, 'git rev-parse HEAD'), head0)
  assert.ok(!existsSync(join(s.install, 'greet.js')), 'nothing installed while held')
  const report = readFileSync(f.json.report, 'utf8')
  assert.match(report, /What the agent wrote/)
  assert.match(report, /toUpperCase\(\)\}!/)

  const acc = drift(s.fork, ['sync', 'accept'], s.env)
  assert.equal(acc.code, 0, JSON.stringify(acc.json))
  assert.equal(sh(s.fork, 'git rev-parse HEAD'), f.json.pending)
  assert.ok(existsSync(join(s.install, 'greet.js')))
})

test('unattended: discard drops the held result', () => {
  const s = scenario()
  initAndAdopt(s, 'build')
  const head0 = sh(s.fork, 'git rev-parse HEAD')
  const start = drift(s.fork, ['sync', 'start', '--unattended'], s.env)
  resolve(start.json.worktree)
  drift(s.fork, ['sync', 'continue'], s.env)
  drift(s.fork, ['verify'], s.env)
  assert.equal(drift(s.fork, ['sync', 'finish'], s.env).code, 3)
  const d = drift(s.fork, ['sync', 'discard'], s.env)
  assert.equal(d.code, 0)
  assert.equal(sh(s.fork, 'git rev-parse HEAD'), head0)
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/drift/pending'], { cwd: s.fork }).status, 1)
})

test('a failing check is fixed with sync fixup, folded into its own mod', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const start = drift(s.fork, ['sync', 'start'], s.env)
  // A bad resolution: upstream's punctuation kept, the mod's behavior lost.
  write(start.json.worktree, 'greet.js', GREET_V11)
  write(start.json.worktree, 'test/greet.test.js', TEST('Hello, a!'))
  assert.equal(drift(s.fork, ['sync', 'continue'], s.env).code, 0)
  const red = drift(s.fork, ['verify'], s.env)
  assert.equal(red.code, 1)
  assert.equal(red.json.mods.find((m: any) => m.name === '001').ok, false)
  assert.equal(drift(s.fork, ['sync', 'finish'], s.env).code, 1, 'finish refuses on red')

  resolve(start.json.worktree)
  const fx = drift(s.fork, ['sync', 'fixup', '001'], s.env)
  assert.equal(fx.code, 0, JSON.stringify(fx.json))
  assert.equal(drift(s.fork, ['verify'], s.env).code, 0)
  const f = drift(s.fork, ['sync', 'finish'], s.env)
  assert.equal(f.code, 0, JSON.stringify(f.json))
  assert.equal(sh(s.fork, 'git rev-list --count v1.1.0..HEAD'), '3', 'init + two mods, no stray fixup commit')
  assert.match(sh(s.fork, 'git show HEAD~1:greet.js'), /toUpperCase/)
})

test('a mod upstream already contains is reported as absorbed', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  // Upstream ships the shout script itself.
  write(s.up, 'shout.js', 'console.log(require("./greet.js").greet("x"))\n')
  sh(s.up, 'git add -A && git commit -qm "add shout" && git tag v1.3.0')
  const start = drift(s.fork, ['sync', 'start', '--to', 'v1.3.0'], s.env)
  resolve(start.json.worktree)
  const cont = drift(s.fork, ['sync', 'continue'], s.env)
  assert.deepEqual(cont.json.mods, [{ mod: '001', outcome: 'resolved' }, { mod: '002', outcome: 'absorbed' }])
  assert.equal(drift(s.fork, ['verify'], s.env).code, 0)
  const f = drift(s.fork, ['sync', 'finish'], s.env)
  assert.equal(f.code, 0, JSON.stringify(f.json))
  assert.match(readFileSync(f.json.report, 'utf8'), /Upstream now does this/)
})

test('mod amend folds a refinement into the existing mod', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  write(s.fork, 'greet.js', `module.exports.greet = (name) => 'Hello, ' + name.toUpperCase() + '!!'\n`)
  write(s.fork, 'test/greet.test.js', TEST('Hello, A!!'))
  const a = drift(s.fork, ['mod', 'amend', '001', '--request', 'Shout the name, with two bangs.'])
  assert.equal(a.code, 0, JSON.stringify(a.json))
  assert.equal(sh(s.fork, 'git status --porcelain'), '')
  assert.equal(sh(s.fork, 'git rev-list --count v1.0.0..HEAD'), '3')
  assert.match(sh(s.fork, 'git show HEAD~1:greet.js'), /!!/)
  assert.match(sh(s.fork, 'git show HEAD~1:.drift/mods/001.md'), /> Shout the name, with two bangs\./)
  assert.doesNotMatch(sh(s.fork, 'git show HEAD~1:.drift/mods/001.md'), /adopted/)
})

test('a mod that keeps failing exhausts its attempts and finish stays refused', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const start = drift(s.fork, ['sync', 'start'], s.env)
  write(start.json.worktree, 'greet.js', GREET_V11)
  write(start.json.worktree, 'test/greet.test.js', TEST('Hello, a!'))
  drift(s.fork, ['sync', 'continue'], s.env)
  for (let i = 1; i <= 2; i++) {
    assert.equal(drift(s.fork, ['verify'], s.env).code, 1)
    write(start.json.worktree, 'notes.txt', `attempt ${i}\n`)
    assert.equal(drift(s.fork, ['sync', 'fixup', '001'], s.env).code, 0)
  }
  const v = drift(s.fork, ['verify'], s.env)
  assert.equal(v.code, 1)
  assert.deepEqual(v.json.exhausted, ['001'])
  assert.equal(v.json.next, 'abort')
  write(start.json.worktree, 'notes.txt', 'attempt 3\n')
  assert.equal(drift(s.fork, ['sync', 'fixup', '001'], s.env).code, 1)
  assert.equal(drift(s.fork, ['sync', 'abort'], s.env).code, 0)
})

test('a failed install puts the fork back where it was', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const head0 = sh(s.fork, 'git rev-parse HEAD')
  const start = drift(s.fork, ['sync', 'start'], s.env)
  resolve(start.json.worktree)
  drift(s.fork, ['sync', 'continue'], s.env)
  assert.equal(drift(s.fork, ['verify'], s.env).code, 0)
  const f = drift(s.fork, ['sync', 'finish'], { INSTALL_DIR: join(s.root, 'missing/dir') })
  assert.equal(f.code, 1, JSON.stringify(f.json))
  assert.equal(f.json.status, 'install-failed')
  assert.equal(sh(s.fork, 'git rev-parse HEAD'), head0)
  assert.equal(sh(s.fork, 'git status --porcelain'), '')
  assert.equal(drift(s.fork, ['status', '--offline']).json.sync, undefined)
})

test('finish refuses when the checkout moved during the sync', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const start = drift(s.fork, ['sync', 'start'], s.env)
  resolve(start.json.worktree)
  drift(s.fork, ['sync', 'continue'], s.env)
  drift(s.fork, ['verify'], s.env)
  write(s.fork, 'later.txt', 'x\n')
  drift(s.fork, ['mod', 'commit', '--request', 'later', '--check', 'build'])
  const f = drift(s.fork, ['sync', 'finish'], s.env)
  assert.equal(f.code, 1)
  assert.match(f.json.error, /HEAD moved/)
})

test('sync start refuses commits that were never adopted', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  write(s.fork, 'stray.txt', 'x\n')
  sh(s.fork, 'git add -A && git commit -qm stray')
  const r = drift(s.fork, ['sync', 'start'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.json.unadopted[0].subject, 'stray')
})

test('config changes rewrite the init commit, not add one', () => {
  const s = scenario()
  initAndAdopt(s, CHECK)
  const r = drift(s.fork, ['config', 'unattended.flagged', 'finish'])
  assert.equal(r.code, 0, JSON.stringify(r.json))
  assert.equal(r.json.config.unattended.flagged, 'finish')
  assert.equal(sh(s.fork, 'git rev-list --count v1.0.0..HEAD'), '3')
  assert.match(sh(s.fork, 'git show HEAD~2:.drift/config'), /"flagged": "finish"/)
})
