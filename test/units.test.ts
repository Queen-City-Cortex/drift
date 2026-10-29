import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatIntent, parseIntent } from '../src/mods.ts'
import { isPrerelease } from '../src/repo.ts'

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
