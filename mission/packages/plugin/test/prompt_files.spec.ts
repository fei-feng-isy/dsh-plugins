/**
 * The guidance section's text is editable on disk: one `.md` under `<data home>/prompts`, the
 * shared family prompt directory.
 *
 * What has to stay true when a user edits it is the BOUNDARY, and that is what these cases pin: the
 * file name → section mapping owned by code (an edit cannot move the section), the default a missing
 * file is filled with being the very constant above rather than a copy of it, the whole ensure →
 * read → inject flow working against a real directory, and the warnings an edited file earns without
 * being modified. The registration itself is covered by `prompt_files_mount.spec.ts`.
 *
 * Harness-free on purpose (no `./mount.js`): this is the half that must hold without a DSH host.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as base from '@avantf/dsh-plugin-base'
import { PromptFiles } from '@avantf/dsh-plugin-base'
import {
  GUIDANCE_BUDGET,
  GUIDANCE_TREE_WORDS,
  PROMPT_FILES,
  MISSION_TREE_GUIDANCE,
  buildGuidanceText,
  guidanceTextWarnings,
  promptDir,
  promptFileSpecs,
  resolveDataHome,
} from '../src/prompt.js'

describe('the editable guidance file', () => {
  it('maps exactly one file, and the identity stays in code', () => {
    expect(PROMPT_FILES.map((entry) => entry.file)).toEqual(['mission-tree-guide.md'])
    // The default a missing/blank file is filled with IS the constant — not a second copy of it.
    expect(promptFileSpecs()).toEqual([{ file: 'mission-tree-guide.md', fallback: MISSION_TREE_GUIDANCE }])
  })

  it('resolves the shared prompt directory by the FAMILY order: $AVANTF_HOME, else the config, else ~/.avantf', () => {
    // The configured `dataHome` is layer ② and the environment is layer ④ (root `AGENTS.md`
    // 「边界与路径」), so the environment is the deployment override that wins. This used to be the
    // opposite here: the config value was handed to the resolver's EXPLICIT slot, which promoted it
    // above the environment and made `$AVANTF_HOME` dead on this side of the family.
    expect(promptDir('/tmp/configured', { AVANTF_HOME: '/tmp/family' })).toBe('/tmp/family/prompts')
    expect(promptDir('/tmp/configured', {})).toBe('/tmp/configured/prompts')
    // A blank value is "unset", not "the filesystem root" — for both layers.
    expect(promptDir('  ', { AVANTF_HOME: '   ' })).toBe(join(homedir(), '.avantf', 'prompts'))
    expect(promptDir(undefined, {})).toBe(join(homedir(), '.avantf', 'prompts'))
    // `~/` (and a bare `~`) is expanded, as it is for every other configured path.
    expect(promptDir('~/custom')).toBe(join(homedir(), 'custom', 'prompts'))
    expect(promptDir('~')).toBe(join(homedir(), 'prompts'))
  })

  it('uses the BASE\'s data-home resolver at runtime, and its own fallback only without one', () => {
    // `apply` hands `promptDir` the loaded base's `resolveDataHome`; the local one is the base-less
    // degradation path. Pinning the wiring here means a prompt layer that silently stopped taking the
    // base's convention (two resolves could drift) shows up as a failing test, not as text in the
    // wrong directory.
    const calls: { explicit?: string; env?: Record<string, string | undefined>; configured?: string }[] = []
    const sentinel = (input: { explicit?: string; env?: Record<string, string | undefined>; configured?: string }) => {
      calls.push(input)
      return '/sentinel/base-data-home'
    }
    expect(promptDir('/configured', { AVANTF_HOME: '/family' }, sentinel)).toBe('/sentinel/base-data-home/prompts')
    // The configured value travels in the NAMED layer ② slot, never as the explicit one — that is
    // the whole point of the object.
    expect(calls[0]).toEqual({ explicit: undefined, env: { AVANTF_HOME: '/family' }, configured: '/configured' })
    // Without a resolver the local fallback answers, so a base-less mount still finds a directory.
    expect(promptDir(undefined, {}, undefined)).toBe(join(homedir(), '.avantf', 'prompts'))
  })

  it('gives the same answer as the linked BASE for the same named slots', () => {
    // The base is a REQUIRED peer here, so `base.resolveDataHome` is the linked workspace copy — the
    // real implementation, not a mock. The local `resolveDataHome` is the base-less degradation path;
    // a divergence between the two would put this plugin's prompt files in a different directory from
    // the one every other family member reads.
    for (const configured of [undefined, '', '  ', '/tmp/configured', '~/custom', '~']) {
      for (const env of [{}, { AVANTF_HOME: '/tmp/family' }, { AVANTF_HOME: '   ' }, { AVANTF_HOME: '~' }]) {
        expect(resolveDataHome({ configured, env }), `configured=${String(configured)} env=${JSON.stringify(env)}`)
          .toBe(base.resolveDataHome({ configured, env }))
      }
    }
    expect(resolveDataHome({ explicit: '/tmp/caller', configured: '/tmp/configured', env: { AVANTF_HOME: '/tmp/family' } }))
      .toBe(base.resolveDataHome({ explicit: '/tmp/caller', configured: '/tmp/configured', env: { AVANTF_HOME: '/tmp/family' } }))
  })

  it('round-trips through a real directory: an edited file wins, a missing one is created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-mission-prompts-'))
    try {
      // No file yet: the default is used and written out.
      const created = buildGuidanceText(new PromptFiles({ dir }).load(promptFileSpecs()))
      expect(created).toBe(MISSION_TREE_GUIDANCE)
      expect(readFileSync(join(dir, 'mission-tree-guide.md'), 'utf8').trim()).toBe(MISSION_TREE_GUIDANCE)

      // Now an edited file: it must be what the section says, byte for byte.
      const mine = '只讲任务，不讲形状。这条是自定义的。'
      writeFileSync(join(dir, 'mission-tree-guide.md'), `${mine}\n`, 'utf8')
      const loaded = new PromptFiles({ dir }).load(promptFileSpecs())
      expect(loaded[0]?.source).toBe('file')
      expect(buildGuidanceText(loaded)).toBe(mine)
      expect(readFileSync(join(dir, 'mission-tree-guide.md'), 'utf8')).toBe(`${mine}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns about edited text that reproduces a measured regression, without touching it', () => {
    // The default passes (the cases above index it): this is only about text the USER wrote.
    expect(guidanceTextWarnings(MISSION_TREE_GUIDANCE)).toEqual([])

    // Tree vocabulary is the measured regression: it invites reading a mission as a container of nodes.
    const vocabulary = guidanceTextWarnings(`先看${String(GUIDANCE_TREE_WORDS[0])}长什么样。`)
    expect(vocabulary).toHaveLength(1)
    expect(vocabulary[0]).toContain('avantf:mission-tree-guide')

    const overBudget = guidanceTextWarnings('x'.repeat(GUIDANCE_BUDGET + 1))
    expect(overBudget).toHaveLength(1)
    expect(overBudget[0]).toContain(String(GUIDANCE_BUDGET + 1))
  })
})
