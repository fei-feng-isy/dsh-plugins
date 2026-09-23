/**
 * `publishAtomically`'s replacement window.
 *
 * The original implementation removed the target and then renamed, so for the whole duration of an
 * `rm -rf` of a real tool tree — hundreds of milliseconds — the version directory did not exist and a
 * concurrently started binary got ENOENT (and retried the install). These specs pin the two properties
 * that replaced it: the old tree is moved ASIDE and put back if the publish fails, and a successful
 * publish leaves no `.old-` residue behind.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProvisionError } from '../src/errors.js'
import { publishAtomically } from '../src/fetch.js'

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'avf-publish-'))
}

/** A version directory with one file in it, so "which tree is in place" is a string comparison. */
function tree(root: string, content: string): void {
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'pandoc'), content)
}

describe('publishAtomically', () => {
  it('replaces an existing version directory and leaves no residue', () => {
    const home = sandbox()
    try {
      const target = join(home, 'pandoc', '3.11')
      tree(target, 'old')
      const staging = join(home, 'staged')
      tree(staging, 'new')

      publishAtomically(staging, target, 'pandoc')

      expect(readFileSync(join(target, 'bin', 'pandoc'), 'utf8')).toBe('new')
      // Staging was RENAMED, not copied, and the tree it replaced did not survive as an `.old-…`.
      expect(existsSync(staging)).toBe(false)
      expect(readdirSync(join(home, 'pandoc'))).toEqual(['3.11'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('puts the old version back when the publish fails', () => {
    const home = sandbox()
    try {
      const target = join(home, 'pandoc', '3.11')
      tree(target, 'old')

      // A staging path that does not exist stands in for any failed second rename. The old tree has
      // to come back: "the previous install survived a failed upgrade" is the property the ordering
      // exists for, and the version before it (remove, then rename) could not offer it.
      expect(() => publishAtomically(join(home, 'missing-staging'), target, 'pandoc')).toThrow(ProvisionError)
      expect(readFileSync(join(target, 'bin', 'pandoc'), 'utf8')).toBe('old')
      expect(readdirSync(join(home, 'pandoc'))).toEqual(['3.11'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('installs into a version directory that does not exist yet', () => {
    const home = sandbox()
    try {
      const target = join(home, 'pandoc', '3.11')
      const staging = join(home, 'staged')
      tree(staging, 'first')

      publishAtomically(staging, target, 'pandoc')

      expect(readFileSync(join(target, 'bin', 'pandoc'), 'utf8')).toBe('first')
      expect(readdirSync(join(home, 'pandoc'))).toEqual(['3.11'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
