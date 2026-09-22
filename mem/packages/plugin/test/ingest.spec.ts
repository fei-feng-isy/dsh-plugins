/**
 * The 知识 tab's 入库 collision step: the pure half (recognise the report, phrase the question) and
 * a source guard that the wiring actually asks BEFORE replacing.
 *
 * The host writes nothing when it answers with a conflict report, so "did we ask?" and "did a
 * cancel send a second write?" are the two behaviours that decide whether a user can lose a
 * document by clicking 入库 once too often. The first half is unit-tested directly; the second is
 * pinned in the client source, the same approach `domains.spec.ts` uses for its wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { KbConflictReport } from '@avantf/mem-contract'
import { conflictMessage, ingestConflict } from '../src/client/ingest.js'

const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

const report: KbConflictReport = {
  conflict: true,
  error: '已存在同名文档：doc_id=3「x」。',
  conflicts: [
    { doc_id: 3, title: 'x', path: '/docs/notes/default/x.md' },
    { doc_id: 4, title: 'y', path: '/docs/notes/default/y.md' },
  ],
  would_overwrite: 2,
  would_add: 1,
}

describe('ingestConflict', () => {
  it('recognises the host conflict report', () => {
    expect(ingestConflict(report)).toBe(report)
  })

  it('returns null for a landed write, a bare value or a malformed report', () => {
    expect(ingestConflict({ doc_id: 3, chunks: 2 })).toBeNull()
    expect(ingestConflict(null)).toBeNull()
    expect(ingestConflict('ok')).toBeNull()
    expect(ingestConflict([1, 2])).toBeNull()
    // `conflict: true` without a list is not enough to render a dialog from.
    expect(ingestConflict({ conflict: true })).toBeNull()
  })
})

describe('conflictMessage', () => {
  it('summarizes the counts and names every colliding document with its managed path', () => {
    const message = conflictMessage(report)
    expect(message).toContain('将覆盖 2 篇 / 新增 1 篇')
    expect(message).toContain('doc_id=3「x」')
    expect(message).toContain('/docs/notes/default/x.md')
    expect(message).toContain('取消')
  })

  it('caps the list so a whole-library collision is a question, not a wall', () => {
    const many: KbConflictReport = {
      ...report,
      conflicts: Array.from({ length: 20 }, (_, i) => ({ doc_id: i + 1, title: `t${String(i)}`, path: `/p/${String(i)}.md` })),
      would_overwrite: 20,
      would_add: 0,
    }
    const message = conflictMessage(many)
    expect(message).toContain('另有 12 篇')
    expect(message).not.toContain('/p/19.md')
  })
})

describe('知识页入库接线（有冲突 → 必须问用户）', () => {
  it('asks with the conflict summary before replacing', () => {
    expect(CLIENT_SOURCE).toContain('ingestConflict(outcome.value)')
    expect(CLIENT_SOURCE).toContain('globalThis.confirm(conflictMessage(conflict))')
  })

  it('cancelling returns before any second request, so nothing is written', () => {
    // The confirmation is a single guard clause: `false` returns from the handler immediately.
    expect(CLIENT_SOURCE).toContain('|| !globalThis.confirm(conflictMessage(conflict))) return')
  })

  it('re-sends the SAME request with overwrite: true only after confirmation', () => {
    expect(CLIENT_SOURCE).toContain('remote.kb({ ...args, overwrite: true })')
  })
})
