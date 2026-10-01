#!/usr/bin/env node
/**
 * Self-tests for the version tool's baked-constant handling.
 *
 * The base's version lives in TWO places — the publishable manifest and the `VERSION` constant baked
 * into `src/bootstrap.ts` — and these cases pin the two halves that keep them together: the writer
 * moves the constant without touching the rest of the file, and the check reports a split with the
 * command that repairs it. The last case runs the same assertion `pnpm version:check` makes, against
 * this workspace.
 *
 *   node scripts/version.test.mjs
 *
 * @module scripts/version.test
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  BAKED_CARRIERS,
  bakedVersionProblems,
  readBootstrapVersion,
  writeBakedVersion,
} from './lib/bootstrap-version.mjs'
import { repoRoot } from './lib/plugins.mjs'
import { versionState } from './lib/versions.mjs'

const BOOTSTRAP = BAKED_CARRIERS.base
const BODY = "import { x } from 'y'\n\n/** doc */\nexport const VERSION = '%s'\nexport const other = 1\n"

function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'avantf-version-'))
  const file = join(root, BOOTSTRAP)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, BODY.replace('%s', version))
  return root
}

test('writeBakedVersion moves only the constant', () => {
  const root = fixture('0.3.1')
  try {
    const moved = writeBakedVersion(root, 'base', '0.3.2')
    assert.equal(moved.was, '0.3.1')
    assert.equal(moved.file, BOOTSTRAP)
    assert.equal(readBootstrapVersion(join(root, BOOTSTRAP)), '0.3.2')
    assert.equal(readFileSync(join(root, BOOTSTRAP), 'utf8'), BODY.replace('%s', '0.3.2'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a group without a baked carrier is a no-op', () => {
  const root = fixture('0.3.1')
  try {
    assert.equal(writeBakedVersion(root, 'mem', '9.9.9'), undefined)
    assert.deepEqual(bakedVersionProblems(root, { mem: '9.9.9' }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a split is reported, with the command that repairs it', () => {
  const root = fixture('0.3.1')
  try {
    const problems = bakedVersionProblems(root, { base: '0.3.2' })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /bakes 0\.3\.1/u)
    assert.match(problems[0], /pnpm version:set base 0\.3\.2/u)
    assert.deepEqual(bakedVersionProblems(root, { base: '0.3.1' }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bootstrap that declares no VERSION is reported, not skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'avantf-version-'))
  try {
    const file = join(root, BOOTSTRAP)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'export const other = 1\n')
    const problems = bakedVersionProblems(root, { base: '0.3.2' })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /declares no/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('this workspace agrees — the same assertion `pnpm version:check` makes', () => {
  const state = versionState(repoRoot)
  assert.equal(state.versions.base, readBootstrapVersion(join(repoRoot, BOOTSTRAP)))
  assert.deepEqual(bakedVersionProblems(repoRoot, state.versions), [])
})
