/**
 * The click-time lookup of a historical executor session.
 *
 * These cases pin the three candidate filters and the read budget, because the whole point of the
 * feature is that the expensive half (reading session logs) touches only the few sessions that can
 * possibly be the node's executor. They also pin the three "no answer" outcomes, since the panel
 * turns each into its own sentence.
 */
import { describe, expect, it } from 'vitest'
import {
  RESOLVE_READ_BUDGET,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  resolveExecutorSession,
  type ListedSession,
  type SessionQueryLike,
} from '../src/executorSession.js'

const OWNER = 'owner-session'
const NODE = 'a1b2c3d4'

/** A stored-session record as `listSessions()` reports it. */
function worker(id: string, createdAt: number, parent = OWNER): ListedSession {
  return { header: { id, createdAt, parentSession: parent } }
}

/** The node under test: dispatched once, created at 10_000 and last moved at 20_000. */
const NODE_RECORD = { createdAt: 10_000, activityAt: 20_000, updatedAt: 20_000, attempts: 1 }

interface FakeQuery extends SessionQueryLike {
  /** Session ids whose log was READ, in order — the spy the filtering cases assert on. */
  readonly read: string[]
  readonly listCalls: number
}

/** A `sessionQuery` fake whose logs are given per session id. `undefined` = no matching event. */
function fakeQuery(
  listed: readonly ListedSession[],
  logs: Readonly<Record<string, string>>,
  options: { readonly failing?: readonly string[]; readonly eventAt?: number } = {},
): FakeQuery {
  const read: string[] = []
  const failing = new Set(options.failing ?? [])
  let listCalls = 0
  return {
    read,
    get listCalls() {
      return listCalls
    },
    listSessions: () => {
      listCalls += 1
      return Promise.resolve(listed)
    },
    filterEvents: (sessionId: string, filters: readonly (readonly [string, ...unknown[]])[]) => {
      read.push(sessionId)
      if (failing.has(sessionId)) return Promise.reject(new Error(`stubbed: cannot read ${sessionId}`))
      // The harness's real filter is applied by the backend; this fake mirrors the two clauses the
      // resolver sends, so a case can place an event outside the window or with different text.
      const [time, text] = filters as unknown as readonly [readonly [string, number, number], readonly [string, string]]
      const [from, to] = time.slice(1) as unknown as readonly [number, number]
      const wanted = text[1]
      const body = logs[sessionId]
      if (body === undefined) return Promise.resolve([])
      if (body !== wanted) return Promise.resolve([])
      if (options.eventAt !== undefined && (options.eventAt < from || options.eventAt > to)) {
        return Promise.resolve([])
      }
      return Promise.resolve([{ text: `本任务：\nid: ${NODE}\n标题: x` }])
    },
  } as FakeQuery
}

describe('resolving a historical executor session', () => {
  it('returns the newest matching session and reads only the candidates that pass the filters', async () => {
    const listed = [
      worker('mission-11111111', 12_000), // matches, older
      worker('mission-22222222', 18_000), // in the window but did NOT run this node — read first
      worker('mission-33333333', 20_000 + WINDOW_AFTER_MS + 1), // after the record's last movement
      worker('mission-44444444', 10_000 - WINDOW_BEFORE_MS - 1), // before the record was created
      worker('mission-55555555', 17_000, 'another-owner'), // another owner's subagent
      worker('subagent-not-ours', 17_500), // not the mission id shape
    ]
    const query = fakeQuery(listed, { 'mission-11111111': `id: ${NODE}` })

    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })

    // The spy: only the candidates that passed the metadata filters were read, newest first —
    // not the out-of-window sessions, not another owner's, and not the non-mission id.
    expect(query.read.join(' | ')).toBe('mission-22222222 | mission-11111111')
    // The newest candidate was read and rejected; the older match is the answer.
    expect(resolved).toEqual({ status: 'resolved', sessionId: 'mission-11111111', candidatesRead: 2 })
  })

  it('skips a candidate whose log does not mention the node, and keeps looking', async () => {
    const listed = [worker('mission-aaaaaaa1', 19_000), worker('mission-aaaaaaa2', 18_000)]
    const query = fakeQuery(listed, { 'mission-aaaaaaa2': `id: ${NODE}` })

    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toMatchObject({ status: 'resolved', sessionId: 'mission-aaaaaaa2' })
    expect(query.read).toEqual(['mission-aaaaaaa1', 'mission-aaaaaaa2'])
  })

  it('spends the read budget on the NEWEST candidates and never scans the rest', async () => {
    // Twelve in-window candidates, none of which ran the node: the budget has to bound the scan.
    const listed = Array.from({ length: 12 }, (_, index) =>
      worker(`mission-b${String(index).padStart(7, '0')}`, 11_000 + index * 100))
    const query = fakeQuery(listed, {})

    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toEqual({ status: 'not-found' })
    expect(query.read).toHaveLength(RESOLVE_READ_BUDGET)
    // Newest first: the highest createdAt (11_000 + 11*100) is read first.
    expect(query.read[0]).toBe('mission-b0000011')
    expect(query.read).not.toContain('mission-b0000000')
  })

  it('answers "找不到" when the window is searchable but nothing matches', async () => {
    const query = fakeQuery([worker('mission-cccccccc', 15_000)], {})
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toEqual({ status: 'not-found' })
  })

  it('distinguishes "never dispatched" (attempts 0) from "找不到"', async () => {
    const query = fakeQuery([], {})
    const resolved = await resolveExecutorSession(NODE, {
      node: { ...NODE_RECORD, attempts: 0 },
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toEqual({ status: 'never-dispatched' })
    // Non-vacuity: a never-dispatched node does not even LIST the corpus.
    expect(query.listCalls).toBe(0)
  })

  it('still searches a dispatched node whose record carries no clock, bounded by the budget', async () => {
    // A record that cannot say WHEN is not evidence that it never ran. The widest window plus the
    // read budget keeps the click bounded without inventing a verdict.
    const query = fakeQuery([worker('mission-abcdabcd', 5_000)], { 'mission-abcdabcd': `id: ${NODE}` })
    const resolved = await resolveExecutorSession(NODE, {
      node: { attempts: 1 },
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toMatchObject({ status: 'resolved', sessionId: 'mission-abcdabcd' })
  })

  it('says the host cannot look anything up when sessionQuery is absent, and never throws', async () => {
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query: undefined,
      now: 30_000,
    })
    expect(resolved.status).toBe('unsupported')
    expect(resolved.status === 'unsupported' ? resolved.error : '').toContain('无法查找')
  })

  it('survives one unreadable log and still finds the session in another candidate', async () => {
    const listed = [worker('mission-ddddddd1', 19_000), worker('mission-ddddddd2', 18_000)]
    const query = fakeQuery(listed, { 'mission-ddddddd2': `id: ${NODE}` }, { failing: ['mission-ddddddd1'] })
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toMatchObject({ status: 'resolved', sessionId: 'mission-ddddddd2' })
  })

  it('ignores a text filter that only came CLOSE to the node line', async () => {
    // The regex after the backend's text filter is what makes the answer exact: another node's id
    // shares the prefix, and a session that merely mentions the id in prose must not match.
    const listed = [worker('mission-eeeeeeee', 15_000)]
    const query: SessionQueryLike = {
      listSessions: () => Promise.resolve(listed),
      filterEvents: () =>
        Promise.resolve([{ text: `本任务：\nid: ${NODE}ff\n（提到过 ${NODE}）` }]),
    }
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toEqual({ status: 'not-found' })
  })

  it('holds the session\'s own events to the same window as its creation time', async () => {
    // A candidate created inside the window whose matching event is long outside it is another
    // node's round on a reused session, not this node's executor.
    const listed = [worker('mission-ffffffff', 15_000)]
    const query = fakeQuery(listed, { 'mission-ffffffff': `id: ${NODE}` }, { eventAt: 10_000_000 })
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved).toEqual({ status: 'not-found' })
  })
})
