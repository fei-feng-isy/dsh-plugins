/**
 * The durable layout, and what it guarantees to a document written before this build.
 *
 * The domain is opened with the default `single` layout, whose stamp comparison is exact
 * equality — so a version bump is not a migration, it is a bricked installation (see the
 * `DOMAIN_VERSION` comment). Backward readability therefore rides entirely on new fields being
 * optional-with-default, and these cases are that promise made checkable: a record from before
 * `analysisNotes` / `analysisAttempt` existed must still parse, and must read as "no analysis
 * recorded for any dispatch".
 */
import { describe, expect, it } from 'vitest'
import { DOMAIN_VERSION, treeDocumentSchema } from '../src/domain.js'

/** A node as the FIRST build wrote it: none of the later optional fields. */
function legacyNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n0001',
    rootId: 'n0001',
    parentId: null,
    title: 'Ship it',
    description: 'd',
    context: ['because'],
    status: 'done',
    createdAt: 1,
    depth: 1,
    claimedBy: null,
    claimedAt: 0,
    attempts: 1,
    result: 'done',
    hasResult: true,
    resultReadAt: null,
    resultRef: null,
    children: [],
    updatedAt: 9,
    ...overrides,
  }
}

function legacyDocument(node: Record<string, unknown> = legacyNode()): unknown {
  return {
    tree: { rootId: 'n0001', ownerSessionId: 'owner', createdAt: 1 },
    nodes: { n0001: node },
  }
}

describe('the layout version', () => {
  it('stays 1: the new fields are optional-with-default, not a migration', () => {
    // Bumping this would make every existing `single`-layout document fail to open
    // (`version-mismatch`), so it may only move with a change that is NOT backward
    // readable — and this one is.
    expect(DOMAIN_VERSION).toBe(1)
  })
})

describe('a document written before the analysis fields existed', () => {
  it('still parses, and reads as "no analysis recorded"', () => {
    const parsed = treeDocumentSchema.parse(legacyDocument())
    const node = parsed.nodes['n0001']
    expect(node?.analysisNotes).toEqual([])
    expect(node?.analysisAttempt).toBe(0)
    // The rest of the record is untouched by the defaults.
    expect(node?.context).toEqual(['because'])
    expect(node?.result).toBe('done')
    expect(node?.corrections).toEqual([])
    // The failure budgets were split out of `attempts` later; a document written before them
    // reads as "nothing has failed yet", which is the safe direction (the node keeps its
    // remaining budget rather than being judged a failure on load).
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
    // The continuation handle and the correction watermark arrived the same way. A missing handle
    // must NOT read as "there is a session to wake" (an invented id would be woken), and a missing
    // watermark must read as "nothing delivered yet" so a wake still carries every correction.
    expect(node?.lastWorkerId).toBeNull()
    expect(node?.correctionsDeliveredUpTo).toBe(0)
  })

  it('also accepts a record that already carries them', () => {
    const parsed = treeDocumentSchema.parse(legacyDocument(legacyNode({
      analysisNotes: ['缺前置事实：先拿到调用点清单'],
      analysisAttempt: 2,
    })))
    expect(parsed.nodes['n0001']?.analysisNotes).toEqual(['缺前置事实：先拿到调用点清单'])
    expect(parsed.nodes['n0001']?.analysisAttempt).toBe(2)
  })

  it('carries a continuation handle and a delivery watermark when the record has them', () => {
    const parsed = treeDocumentSchema.parse(legacyDocument(legacyNode({
      lastWorkerId: 'mission-aaaa1111',
      correctionsDeliveredUpTo: 2,
    })))
    expect(parsed.nodes['n0001']?.lastWorkerId).toBe('mission-aaaa1111')
    expect(parsed.nodes['n0001']?.correctionsDeliveredUpTo).toBe(2)
  })

  it('rejects a record whose analysis fields have the wrong shape', () => {
    expect(() => treeDocumentSchema.parse(legacyDocument(legacyNode({ analysisNotes: 'nope' })))).toThrow()
    expect(() => treeDocumentSchema.parse(legacyDocument(legacyNode({ analysisAttempt: 'nope' })))).toThrow()
  })
})
