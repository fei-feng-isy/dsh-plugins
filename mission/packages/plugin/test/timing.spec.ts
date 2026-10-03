/**
 * Mission timing, end to end: the formatter both halves share, the durable default an old record
 * gets, and the three USER-VISIBLE surfaces the feature exists for — `list_missions`,
 * `mission_result`, and the wake the owner gets when a mission ends.
 *
 * The formatter cases use fixed epochs (no wall clock), and the surface cases assert the SHAPE and
 * the RECORD's own instants rather than a real elapsed duration, so nothing here depends on how long
 * the test took to run.
 */
import { describe, expect, it } from 'vitest'
import { mount, callTool, executorFor } from './mount.js'
import { settle } from './fixtures.js'
import { nodeSchema, treeDocumentSchema } from '../src/domain.js'
import { snapshotResultSchema, detailResultSchema } from '../src/wire.js'
import {
  describeTiming,
  formatClock,
  formatDuration,
  timingBadge,
  timingDetail,
} from '../src/timeFormat.js'

/** The local-clock string for `at`, computed with the same Date API so the case is timezone-proof. */
function expectedClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}


describe('the shared time formatter', () => {
  it('renders local MM-DD HH:MM, never a bare ISO string', () => {
    const at = Date.UTC(2026, 9, 3, 9, 21)
    expect(formatClock(at)).toBe(expectedClock(at))
    expect(formatClock(at)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('renders coarse durations, dropping a zero smaller unit', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(130_000)).toBe('2m10s')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(3_900_000)).toBe('1h5m')
    expect(formatDuration(90_000_000)).toBe('1d1h')
    expect(formatDuration(-5)).toBe('0s')
  })

  it('describes a queued, a running and a finished mission differently', () => {
    const base = 1_700_000_000_000
    const queued = { createdAt: base, dispatchedAt: null, endedAt: null }
    expect(describeTiming(queued)).toBe(`等待中（受理 ${formatClock(base)}）`)

    const running = { createdAt: base, dispatchedAt: base + 45_000, endedAt: null }
    expect(describeTiming(running)).toBe(
      `派发 ${formatClock(base + 45_000)}（排队 45s） → 进行中`,
    )

    const finished = { createdAt: base, dispatchedAt: base + 45_000, endedAt: base + 175_000 }
    expect(describeTiming(finished)).toBe(
      `派发 ${formatClock(base + 45_000)}（排队 45s） → 结束 ${formatClock(base + 175_000)}（耗时 2m10s）`,
    )

    // Cancelled in the queue: an end with no dispatch. It says so instead of inventing an execution.
    const cancelled = { createdAt: base, dispatchedAt: null, endedAt: base + 600_000 }
    expect(describeTiming(cancelled)).toContain('未派发')
    expect(describeTiming(cancelled)).toContain(formatClock(base + 600_000))
  })

  it('treats an absent instant as 「—」 rather than as epoch time', () => {
    // The shape an OLD record or an OLD host produces: the fields are absent, not `null`.
    const legacy = { createdAt: undefined, dispatchedAt: undefined, endedAt: undefined }
    expect(timingDetail(legacy as never)).toBe('受理 — ｜ 派发 — ｜ 结束 —')
    expect(timingBadge(legacy as never)).toBeUndefined()
    expect(describeTiming(legacy as never)).toBe('等待中（受理 —）')
  })

  it('derives the row marker from the record, and the dialog line from all three instants', () => {
    const base = 1_700_000_000_000
    expect(timingBadge({ createdAt: base, dispatchedAt: null, endedAt: null })).toBeUndefined()
    expect(timingBadge({ createdAt: base, dispatchedAt: base + 1_000, endedAt: null }))
      .toBe(`起 ${formatClock(base + 1_000)}`)
    expect(timingBadge({ createdAt: base, dispatchedAt: base + 1_000, endedAt: base + 4_000 })).toBe('耗时 3s')
    expect(timingBadge({ createdAt: base, dispatchedAt: null, endedAt: base + 4_000 })).toBe('未派发')

    expect(timingDetail({ createdAt: base, dispatchedAt: base + 1_000, endedAt: base + 4_000 })).toBe(
      `受理 ${formatClock(base)} ｜ 派发 ${formatClock(base + 1_000)} ｜ 结束 ${formatClock(base + 4_000)}`,
    )
  })
})

describe('the durable default for records written before the fields existed', () => {
  it('reads both instants as null, not undefined', () => {
    const raw = {
      tree: { rootId: 'n0001', ownerSessionId: 'owner', createdAt: 1, closedAt: null, reportedAt: null },
      nodes: {
        n0001: {
          id: 'n0001', rootId: 'n0001', parentId: null, title: 'T', description: 'd',
          context: [], status: 'done', createdAt: 1, depth: 1, claimedBy: null, claimedAt: 0,
          attempts: 1, result: 'r', hasResult: true, resultReadAt: null, resultRef: null,
          children: [], updatedAt: 9,
        },
      },
    }
    const parsed = treeDocumentSchema.parse(raw)
    const node = parsed.nodes['n0001']
    expect(node?.dispatchedAt).toBeNull()
    expect(node?.endedAt).toBeNull()
    // And the schema exposes them, so the strict wire codec cannot silently drop them.
    expect(Object.keys(nodeSchema.shape)).toContain('dispatchedAt')
    expect(Object.keys(nodeSchema.shape)).toContain('endedAt')
  })

  it('reads both instants as null on the WIRE too, so an old host renders 「—」 not a crash', () => {
    const snapshot = {
      wire: 3,
      trees: [{
        rootId: 'r1',
        closedAt: null,
        nodes: [{
          id: 'r1', parentId: null, children: [], depth: 1, title: 'T', context: [], corrections: [],
          status: 'done', attempts: 1, createdAt: 1, hasResult: true, resultRef: null,
        }],
      }],
    }
    const parsed = snapshotResultSchema.parse(snapshot)
    const node = parsed.trees[0]?.nodes[0]
    expect(node?.dispatchedAt).toBeNull()
    expect(node?.endedAt).toBeNull()
    expect(timingBadge(node ?? {})).toBeUndefined()
    // The dialog line is legible with the fields missing: 受理 — / 派发 — / 结束 —.
    expect(timingDetail(node ?? {})).toContain('派发 —')

    // The detail wire: an older host does not send `createdAt` either.
    const detail = detailResultSchema.parse({
      node: { id: 'r1', rootId: 'r1', title: 'T', description: 'd', context: [], corrections: [],
        analysisNotes: [], analysisAttempt: 0, status: 'done', attempts: 1, depth: 1, result: 'r',
        resultPointer: null },
      children: [],
    })
    expect(detail.node?.dispatchedAt).toBeNull()
    expect(detail.node?.endedAt).toBeNull()
    expect(timingDetail(detail.node ?? {})).toBe('受理 — ｜ 派发 — ｜ 结束 —')
  })
})

describe('the timing reaches the model-facing surfaces', () => {
  it('carries 派发/结束/耗时 on `list_missions` and on `mission_result`', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'Ship it', description: 'd', analysis: [] },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    await mounted.flush()
    await settle()
    const worker = executorFor(mounted, rootId)
    const submitted = await callTool(mounted, 'submit_mission', { node_id: rootId, result: 'ok' }, worker)
    expect(submitted.ok).toBe(true)
    await mounted.flush()

    const node = mounted.nodeFor(rootId)
    expect(node?.dispatchedAt).not.toBeNull()
    expect(node?.endedAt).not.toBeNull()
    const expected = describeTiming(node ?? {})

    const listed = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(listed.summary).toContain(rootId)
    expect(listed.summary).toContain('派发 ')
    expect(listed.summary).toContain('→ 结束')
    expect(listed.summary).toContain('耗时')
    expect(listed.summary).toContain(expected)

    const result = await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect(result.summary).toContain('派发 ')
    expect(result.summary).toContain('→ 结束')
    expect(result.summary).toContain(`耗时 ${formatDuration((node?.endedAt ?? 0) - (node?.dispatchedAt ?? 0))}`)
    expect(result.data?.['dispatched_at']).toBe(node?.dispatchedAt)
    expect(result.data?.['ended_at']).toBe(node?.endedAt)
  })

  it('shows 等待中 for a node the capacity gate has not dispatched', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 1 } })
    await callTool(mounted, 'create_mission', { title: 'busy', description: 'd', analysis: [] }, mounted.owner)
    const second = await callTool(
      mounted,
      'create_mission',
      { title: 'queued', description: 'd', analysis: [] },
      mounted.owner,
    )
    const queuedId = String(second.data?.['root_id'] ?? '')
    await mounted.flush()
    expect(mounted.nodeFor(queuedId)?.dispatchedAt).toBeNull()
    const listed = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(listed.summary).toContain('等待中（受理 ')
  })

  it('names the start, the end and the duration in the wake the owner gets', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'Ship it', description: 'd', analysis: [] },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    await mounted.flush()
    await settle()
    const worker = executorFor(mounted, rootId)
    await callTool(mounted, 'submit_mission', { node_id: rootId, result: 'ok' }, worker)
    await mounted.flush()

    const wake = mounted.owner.received
      .map((message) => message.content.map((part) => part.text).join(''))
      .find((text) => text.includes('已结束'))
    expect(wake, 'the owner was never told the mission ended').toBeDefined()
    const text = wake ?? ''
    // The user's original complaint: the end-of-mission message used to say only 已完成.
    expect(text).toContain('已结束（已完成）')
    expect(text).toMatch(/派发 \d{2}-\d{2} \d{2}:\d{2}（排队 \d+s）/)
    expect(text).toMatch(/→ 结束 \d{2}-\d{2} \d{2}:\d{2}（耗时 \d+s）/)
    const node = mounted.nodeFor(rootId)
    expect(text).toContain(describeTiming(node ?? {}))
  })
})

describe('the /mission listing carries timing', () => {
  it('prints the root timing on its list line', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'Migrate', description: 'd', analysis: [] },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    await mounted.flush()
    const listed = await mounted.runCommand('mission', '')
    expect(listed.text).toContain(rootId)
    expect(listed.text).toContain('派发 ')
    expect(listed.text).toContain('进行中')
  })
})
