import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ConfigSchema } from '@avantf/mem-contract'
import { DEFAULT_COMMON_CONFIG, ensureCommonConfigFile } from '../src/config/config_files.js'

/**
 * The default `configs/common.yaml`.
 *
 * Two properties matter, and both are about not surprising anyone:
 *
 *  - **Comments only.** The built-in defaults are already in force, so materializing the file must
 *    change NOTHING (an all-comment YAML parses to nothing). If a future edit adds a real key here,
 *    every deployment that never had a config would silently start with that key set.
 *  - **Missing or blank is an unfinished edit, not an empty configuration** — the same rule the
 *    prompt files follow. A file with ANY content is the user's and is never rewritten.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-config-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the default common config', () => {
  it('is comments only, so materializing it cannot change behaviour', () => {
    expect(parse(DEFAULT_COMMON_CONFIG)).toBeNull()
  })

  it('names the schema\'s top-level sections, so a renamed key cannot hide in a comment', () => {
    // Exactly one space after `#` = a SECTION; the deeper-indented lines are that section's keys.
    const documented = [...DEFAULT_COMMON_CONFIG.matchAll(/^# ([A-Za-z][A-Za-z0-9_]*):/gmu)].map((m) => m[1])
    expect(documented.length).toBeGreaterThan(3)
    const shape = (ConfigSchema as unknown as { def: { shape: Record<string, unknown> } }).def.shape
    for (const key of documented) {
      expect(Object.keys(shape), `${key} is not a section of ConfigSchema`).toContain(key)
    }
  })

  it('does NOT advertise a dataHome knob, because this file cannot move the data root', () => {
    // The key IS in the schema, so the "every commented key is a real section" check above would pass
    // either way — and that is the trap: the file sits INSIDE the data root, so it is read only after
    // the root is already resolved, and a `dataHome` here has no effect on anything. It is mentioned
    // in prose (where the root actually comes from) instead of being offered as a knob.
    expect(DEFAULT_COMMON_CONFIG).not.toMatch(/^# dataHome:/mu)
    expect(DEFAULT_COMMON_CONFIG).toContain('AVANTF_HOME')
  })

  it('names both managed-key escape hatches and the family root', () => {
    // These are the two things a reader cannot guess, and the reason the file exists at all.
    expect(DEFAULT_COMMON_CONFIG).toContain('AVANTF_MEM_MODEL_CACHE')
    expect(DEFAULT_COMMON_CONFIG).toContain('AVANTF_TOOLS_DIR')
    expect(DEFAULT_COMMON_CONFIG).toContain('.avantf/env/tools')
  })
})

describe('ensureCommonConfigFile', () => {
  it('writes the default when the file is missing', () => {
    const path = join(dir, 'configs', 'common.yaml')
    ensureCommonConfigFile(path)
    expect(readFileSync(path, 'utf8')).toBe(DEFAULT_COMMON_CONFIG)
  })

  it('fills a blank file, and leaves any file with content alone', () => {
    const path = join(dir, 'common.yaml')
    writeFileSync(path, '   \n\n', 'utf8')
    ensureCommonConfigFile(path)
    expect(readFileSync(path, 'utf8')).toBe(DEFAULT_COMMON_CONFIG)

    const mine = 'semantic:\n  dim: 1024\n'
    writeFileSync(path, mine, 'utf8')
    ensureCommonConfigFile(path)
    expect(readFileSync(path, 'utf8')).toBe(mine)
  })

  it('never throws on an unusable path — the built-in defaults still apply', () => {
    // A directory sitting where the file belongs: reading it fails, and that has to end in a warning
    // and the built-in defaults, never in a thrown error out of `loadConfig`/plugin mount.
    const path = join(dir, 'common.yaml')
    mkdirSync(path)
    const warnings: string[] = []
    expect(() => { ensureCommonConfigFile(path, { info() {}, warn: (m: string) => warnings.push(m), error() {} }) }).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('built-in defaults')
  })
})
