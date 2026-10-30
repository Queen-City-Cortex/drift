import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatIntent, parseIntent } from '../src/mods.ts'
import { isPrerelease } from '../src/repo.ts'
import { modFlags } from '../src/flags.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('intent files round-trip, multi-line requests included', () => {
  const i = { mod: '004', request: 'First line.\n\nSecond "quoted" line.', check: 'npm test -- x', adopted: true }
  assert.deepEqual(parseIntent(formatIntent(i), '004'), i)
})

test('intent files written by the experiment parse', () => {
  const text = '---\nmod: "006"\ncheck: build\n---\n\n## Request\n\n> Never suggest a version that is not published.\n'
  assert.deepEqual(parseIntent(text, '006'), { mod: '006', request: 'Never suggest a version that is not published.', check: 'build', adopted: false })
})

test('prerelease tags are recognized', () => {
  for (const t of ['v1.2.0-rc.1', '2.0.0-beta', 'v3.0.0-next.4', 'v1.0rc1']) assert.ok(isPrerelease(t), t)
  for (const t of ['v1.2.0', '23.1.1', 'release-2026-10']) assert.ok(!isPrerelease(t), t)
})

test('a multi-line check is refused rather than truncated', () => {
  assert.throws(() => formatIntent({ mod: '001', request: 'r', check: 'true\nfalse' }), /one line/)
})

test('moving an upstream test with a small edit still counts as rewriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-flags-'))
  const run = (cmd: string) => execFileSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
  const body = (last: string) => Array.from({ length: 20 }, (_, i) => `assert(${i})`).join('\n') + `\n${last}\n`
  run('git init -q -b main && mkdir test')
  writeFileSync(join(dir, 'test/a.test.js'), body('assert("v1")'))
  run('git add -A && git commit -qm v1')
  const from = run('git rev-parse HEAD')
  writeFileSync(join(dir, 'test/a.test.js'), body('assert("v2")'))
  run('git commit -qam v2')
  const to = run('git rev-parse HEAD')
  run('git mv test/a.test.js test/b.test.js')
  writeFileSync(join(dir, 'test/b.test.js'), body('assert("mine")'))
  run('git add -A && git commit -qm mod')
  assert.ok(run('git diff --name-status HEAD^ HEAD').startsWith('R'), 'git sees a rename')
  const f = modFlags(dir, run('git rev-parse HEAD'), from, to)
  assert.deepEqual(f.rewritesTests, ['test/a.test.js'])
  assert.deepEqual(f.overrides.map((o) => o.file), ['test/a.test.js'])
})
