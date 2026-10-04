/**
 * The PUBLISHED face no longer carries the rerank seam (0.5.0, 方案 B).
 *
 * `@avantf/dsh-mem` re-exports the pluggable-retrieval surface from `@avantf/mem`; the third member
 * (`registerReranker` + the `Reranker` type) was removed together with the adapter and the config
 * section (docs/review/RETRIEVAL_RERANK_NECESSITY.md). Removing it is a BREAKING public change, so it
 * is pinned here as a deliberate edit rather than left to review.
 *
 * WHY A SOURCE SCAN. This spec must run in the harness-free CI half, where `src/index.ts` cannot even
 * be imported (it pulls `@deepseek-ai/*` peers). The re-export block is plain text, and the failure
 * mode we care about — the symbol coming back on the published face — is visible in that text. A
 * temporary re-add of `registerReranker` to the block turns every assertion below red (the mutation
 * proof recorded with the 0.5.0 change).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const INDEX_SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const REMOTE_SOURCE = readFileSync(new URL('../src/remote.ts', import.meta.url), 'utf8')
const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** Strip comments so a historical note about the removal is not mistaken for live code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The named members of the `export { … } from '@avantf/mem'` block, comments stripped. */
function engineReexports(): string[] {
  // `[^{}]*` (not `[\s\S]*?`) so the capture cannot run past an earlier `export { … } from './x.js'`.
  const match = /export\s*\{([^{}]*)\}\s*from\s*'@avantf\/mem'/.exec(INDEX_SOURCE)
  expect(match, 'the @avantf/mem re-export block must exist').not.toBeNull()
  return (match?.[1] ?? '')
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member !== '')
}

describe('the published face has no rerank seam', () => {
  it('re-exports exactly the semantic and vector-store surfaces', () => {
    expect(engineReexports().sort()).toEqual([
      'registerSemanticBackend',
      'registerVectorStore',
      'type SemanticBackend',
      'type VectorStore',
    ])
  })

  it('names no removed rerank symbol anywhere in the plugin entry', () => {
    // A bare mention (even in a comment re-introducing it) is a smell worth failing on here: this
    // file is the published surface, and the removal was deliberate.
    expect(INDEX_SOURCE).not.toMatch(/\bregisterReranker\b/)
    expect(INDEX_SOURCE).not.toMatch(/\bReranker\b/)
    expect(INDEX_SOURCE).not.toMatch(/\bresolveReranker\b/)
  })

  it('no longer stamps a rerank counter onto the wire payload', () => {
    // The revision-history comment in remote.ts deliberately NAMES the removed fields; only live code
    // is asserted here.
    expect(code(REMOTE_SOURCE)).not.toMatch(/rerank/i)
  })

  it('no longer renders the removed rerank counters in the panel', () => {
    expect(code(CLIENT_SOURCE)).not.toMatch(/rerank/i)
  })
})
