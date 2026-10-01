/**
 * One definition of a claim id, and the two things it decides: whether a settlement notice is
 * ours to swallow, and whether a session is one of our workers at all.
 */
import { describe, expect, it } from 'vitest'
import { isWorkerClaimId, newClaimId } from '../src/claims.js'
import { agent, callTool, mount } from './mount.js'

describe('the claim id format', () => {
  it('recognizes exactly what it mints', () => {
    // The pinned invariant: format and predicate cannot drift apart silently, which is how
    // `/archive` and `/clean` would start reporting "no mission sessions" — an answer that looks
    // like a clean state.
    for (let round = 0; round < 32; round += 1) {
      const id = newClaimId()
      expect(isWorkerClaimId(id), id).toBe(true)
    }
  })

  it('refuses what the harness names its own children, and near misses', () => {
    expect(isWorkerClaimId('f4f3163b-1111-2222-3333-444455556666')).toBe(false)
    expect(isWorkerClaimId('mission-1234ABCD')).toBe(false) // uppercase
    expect(isWorkerClaimId('mission-1234abc')).toBe(false) // short
    expect(isWorkerClaimId('mission-1234abcde')).toBe(false) // long
    // `task-` is the HARNESS's own child-session prefix (not ours, and deliberately not
    // renamed with this plugin): the near-miss that matters is the one that looks like ours.
    expect(isWorkerClaimId('task-1234abcd')).toBe(false)
  })

  it('is what the dispatch path actually uses', async () => {
    const mounted = await mount()
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    await mounted.flush()
    const claimId = String(mounted.dispatched[0]?.childId ?? '')
    expect(isWorkerClaimId(claimId), claimId).toBe(true)
    // ...and the tree binds that exact id.
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]?.status)
      .toBe('running')
  })
})

describe('provenance survives a restart', () => {
  it('recognizes a worker minted before this process started', async () => {
    // The tree cannot supply this: a node that already submitted released its claim. The id
    // SHAPE is the durable answer, and without it every pre-restart worker's settlement notice
    // lands in the owner's history — the thing §5.4.3 exists to prevent.
    const mounted = await mount()
    expect(mounted.host.isWorkerClaim('mission-1234abcd')).toBe(true)
    expect(mounted.host.isWorkerClaim('f4f3163b-1111-2222-3333-444455556666')).toBe(false)
  })

  it('re-enables the gate for a session that already owned trees', async () => {
    // `dispatchedFor` is rebuilt from the trees: they ARE the durable record of who owns what,
    // so a restart must not leave a mission-owning session ungated and without guidance.
    const mounted = await mount()
    const other = agent('session-that-owned-before')
    expect(mounted.host.ownsTrees(other as never)).toBe(false)
    expect(mounted.host.ownsTrees(mounted.owner as never)).toBe(false)
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    expect(mounted.host.ownsTrees(mounted.owner as never)).toBe(true)
  })
})
