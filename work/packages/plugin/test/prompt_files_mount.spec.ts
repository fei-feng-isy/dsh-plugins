/**
 * The guidance section is editable on disk, and what the file says is what the model reads.
 *
 * This is the end-to-end half of `prompt_files.spec.ts`: a real mount, a file seeded BEFORE it (the
 * plugin reads the directory once, at apply), and the registered section asked for its text. The
 * regression it exists for is a plugin that creates the file and then injects the built-in default
 * anyway — which no unit test of the loader can see.
 *
 * Its own file, not a case in `guidance.spec.ts`: `mount()` hands the plugin a home whose value is
 * fixed at module load, so a test that seeds a file would otherwise change what every later test in
 * that file mounts with.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agent, mount } from './mount.js'
import { promptDir } from '../src/prompt.js'

const EDITED = '只讲工作，不讲形状。这条是 smoke 预置的自定义提示词。'

describe('an edited guidance file', () => {
  it('is what the registered section returns, for a session that may root a work', async () => {
    const dir = promptDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'work-tree-guide.md'), `${EDITED}\n`, 'utf8')

    const mounted = await mount()
    const found = mounted.sections.find((entry) => entry.name === 'avantf:work-tree-guide')
    expect(found).toBeDefined()
    // The identity is still the plugin's: same name, same placement with the tool guidance.
    expect(found?.order).toBe(mounted.sections[0]?.order)
    expect(found?.text({ agent: mounted.owner })).toBe(EDITED)
    // A session that may not root a work still gets nothing, edited file or not.
    expect(found?.text({ agent: agent('someone-else', { origin: 'subagent', delegationDepth: 1 }) })).toBe('')
  })
})
