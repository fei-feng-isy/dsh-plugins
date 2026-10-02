/**
 * The click-time lookup of a historical executor session.
 *
 * These cases pin the three candidate filters and the read budget, because the whole point of the
 * feature is that the expensive half (reading session logs) touches only the few sessions that can
 * possibly be the node's executor. They also pin the three "no answer" outcomes, since the panel
 * turns each into its own sentence.
 *
 * W20: the service fake used to mirror a TUPLE filter (`['time', from, to]`) that the real contract
 * does not have, so a total outage ("no historical executor was ever found") passed a green suite.
 * Every fake here now checks the real `{kind:'time'|'text'}` object union, and the last block pins
 * that shape against the real `@deepseek-ai/dsh-session-query` package itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEventResultFilter, SessionEventSearchDocument } from '@deepseek-ai/dsh-session-query'
import { filterSessionEventDocuments, materializeSessionEventResultFilters } from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  RESOLVE_READ_BUDGET,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  resolveExecutorSession,
  type ListedSession,
  type SessionQueryLike,
} from '../src/executorSession.js'
import { checkEventFilters, type SentEventFilter } from './sessionQueryContract.js'

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
  /** Every filter array the resolver sent, as received — the contract-shape assertion's subject. */
  readonly sent: readonly (readonly SentEventFilter[])[]
  /** Clauses that were not real `SessionEventResultFilter` objects; a tuple lands here. */
  readonly violations: readonly string[]
}

/** Every fake built in this file, so one `afterEach` can fail any case that sent a wrong shape. */
const fakes: FakeQuery[] = []

afterEach(() => {
  // The guard the W20 suite lacked: a resolver that sends tuples fails HERE, whatever the case
  // happened to assert about its answer.
  for (const fake of fakes) expect(fake.violations).toEqual([])
  fakes.length = 0
})

/** A `sessionQuery` fake whose logs are given per session id. `undefined` = no matching event. */
function fakeQuery(
  listed: readonly ListedSession[],
  logs: Readonly<Record<string, string>>,
  options: { readonly failing?: readonly string[]; readonly eventAt?: number } = {},
): FakeQuery {
  const read: string[] = []
  const sent: (readonly SentEventFilter[])[] = []
  const violations: string[] = []
  const failing = new Set(options.failing ?? [])
  let listCalls = 0
  const fake: FakeQuery = {
    read,
    sent,
    violations,
    get listCalls() {
      return listCalls
    },
    listSessions: () => {
      listCalls += 1
      return Promise.resolve(listed)
    },
    // Typed as the REAL object union: a tuple call would not compile here, and the runtime check
    // below catches one that arrived through a cast anyway.
    filterEvents: (sessionId: string, filters: readonly SentEventFilter[]) => {
      read.push(sessionId)
      const clauses = checkEventFilters(filters, (detail) => violations.push(detail))
      sent.push(clauses)
      if (failing.has(sessionId)) return Promise.reject(new Error(`stubbed: cannot read ${sessionId}`))
      // The harness's real filter is applied by the backend; this fake mirrors the two clauses the
      // resolver sends, so a case can place an event outside the window or with different text.
      const time = clauses.find((clause) => clause.kind === 'time')
      const text = clauses.find((clause) => clause.kind === 'text')
      const from = time?.kind === 'time' ? time.from ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY
      const to = time?.kind === 'time' ? time.to ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      const wanted = text?.kind === 'text' ? text.text : undefined
      const body = logs[sessionId]
      if (body === undefined) return Promise.resolve([])
      if (body !== wanted) return Promise.resolve([])
      if (options.eventAt !== undefined && (options.eventAt < from || options.eventAt > to)) {
        return Promise.resolve([])
      }
      return Promise.resolve([{ text: `本任务：\nid: ${NODE}\n标题: x` }])
    },
  }
  fakes.push(fake)
  return fake
}

describe('resolving a historical executor session', () => {
  it('asks the query engine with the REAL object filters, not tuples (the W20 bug)', async () => {
    const query = fakeQuery([worker('mission-1234abcd', 12_000)], { 'mission-1234abcd': `id: ${NODE}` })
    await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    // Exactly the two clauses the real contract declares and the resolver sends in this order:
    // `{kind:'time'}` narrowed to the node's window, then `{kind:'text'}` with the prompt's id line.
    // W20's suite asserted nothing about this, which is how the tuple guess stayed invisible.
    expect(query.sent).toEqual([[
      { kind: 'time', from: NODE_RECORD.createdAt - WINDOW_BEFORE_MS, to: NODE_RECORD.updatedAt + WINDOW_AFTER_MS },
      { kind: 'text', text: `id: ${NODE}` },
    ]])
    expect(query.violations).toEqual([])
  })

  it('the contract check itself fails on a tuple (so the guard above is not vacuous)', () => {
    const violations: string[] = []
    checkEventFilters([['time', 1, 2], ['text', 'id: x']], (detail) => violations.push(detail))
    expect(violations).toHaveLength(2)
    expect(violations[0]).toContain('TUPLE')
  })

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

  it('reports a failed log read ONCE per lookup, with the session and the reason, then keeps going', async () => {
    const listed = [
      worker('mission-99999999', 19_000),
      worker('mission-88888888', 18_900),
      worker('mission-77777777', 18_000),
    ]
    // Two unreadable logs: the failure must be VISIBLE (a swallowed shape error is what hid W20),
    // but once per lookup — not once per candidate — and the remaining candidate is still asked.
    const query = fakeQuery(listed, {}, { failing: ['mission-99999999', 'mission-88888888'] })
    const warnings: string[] = []
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
      warn: (message) => warnings.push(message),
    })
    expect(resolved).toEqual({ status: 'not-found' })
    expect(query.read).toEqual(['mission-99999999', 'mission-88888888', 'mission-77777777'])
    expect(warnings).toHaveLength(1)
    // The one line names the session it was about AND carries the error's own summary.
    expect(warnings[0]).toContain('mission-99999999')
    expect(warnings[0]).toContain('stubbed: cannot read mission-99999999')
  })

  /**
   * N7: "none of the candidates could be read" is NOT "no candidate matched". The panel already has a
   * sentence for `unsupported` (it carries the host's own words), so the resolver must answer with
   * that status instead of letting a broken filter shape or a dead backend wear the "已被清理" mask.
   */
  it('answers `unsupported` with the first reason when EVERY candidate log failed to read', async () => {
    const listed = [worker('mission-aaaaaaa1', 19_000), worker('mission-aaaaaaa2', 18_000)]
    const query = fakeQuery(listed, {}, { failing: ['mission-aaaaaaa1', 'mission-aaaaaaa2'] })
    const warnings: string[] = []
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
      warn: (message) => warnings.push(message),
    })
    expect(resolved.status).toBe('unsupported')
    const error = resolved.status === 'unsupported' ? resolved.error : ''
    // The FIRST failure's own words, so the shape error that hid W20 survives to the surface...
    expect(error).toContain('无法读取任何候选会话的日志')
    expect(error).toContain('stubbed: cannot read mission-aaaaaaa1')
    // ...on one line, capped like every other host reason (the panel renders it inside a sentence).
    expect(error).not.toContain('\n')
    expect(error.length).toBeLessThan(240)
    // The warn sink keeps its "once per lookup" contract unchanged.
    expect(warnings).toHaveLength(1)
    // Non-vacuity: the same candidates with ONE readable log is a plain miss, not an outage.
    const partly = fakeQuery(listed, {}, { failing: ['mission-aaaaaaa1'] })
    expect(await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query: partly,
      now: 30_000,
    })).toEqual({ status: 'not-found' })
  })

  it('answers `unsupported` when the service cannot filter events at all', async () => {
    // A `sessionQuery` missing `filterEvents` fails every candidate identically — the same outage the
    // previous build reported as "找不到". Cast through the shape the contract forbids, because that
    // is exactly how such a host reaches this code.
    const listed = [worker('mission-aaaaaaa1', 19_000)]
    const query = {
      listSessions: () => Promise.resolve(listed),
    } as unknown as SessionQueryLike
    const resolved = await resolveExecutorSession(NODE, {
      node: NODE_RECORD,
      ownerSessionId: OWNER,
      query,
      now: 30_000,
    })
    expect(resolved.status).toBe('unsupported')
    expect(resolved.status === 'unsupported' ? resolved.error : '').toContain('filterEvents')
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

/**
 * The cross-package pin: `@deepseek-ai/dsh-session-query` is this plugin's declared (optional) peer
 * and is linked for the local gate, so the shape the resolver sends is checked by the package that
 * OWNS the contract, not by another local restatement of it. The real `filterEvents` runs every
 * clause through `materializeSessionEventResultFilters` before it reads a log — the exact call the
 * W20 tuples died in (`session unknown filter kind (missing)`) — so materializing our clauses here
 * reproduces the failure line instead of imitating it.
 */
describe('the executor lookup filters against the real session-query package', () => {
  /** Exactly what `sessionRanNode` sends, captured through the validating fake above. */
  async function sentClauses(): Promise<readonly SessionEventResultFilter[]> {
    const query = fakeQuery([worker('mission-1234abcd', 12_000)], { 'mission-1234abcd': `id: ${NODE}` })
    await resolveExecutorSession(NODE, { node: NODE_RECORD, ownerSessionId: OWNER, query, now: 30_000 })
    return query.sent[0] ?? []
  }

  it('accepts our clauses and selects the right event through the real package', async () => {
    // Compile-time pin: what we emit is assignable to the contract's own type. A tuple is not.
    const clauses: readonly SessionEventResultFilter[] = await sentClauses()
    const materialized = materializeSessionEventResultFilters(clauses)
    expect(materialized).toEqual(clauses)

    const document: SessionEventSearchDocument = {
      sessionId: 'mission-1234abcd' as SessionId,
      seq: 1 as SessionSeq,
      type: 'user/message',
      time: 15_000,
      surface: 'current',
      text: `本任务：\nid: ${NODE}\n标题: x`,
    }
    // In the window AND carrying the id line: the real predicate engine selects it.
    expect(filterSessionEventDocuments([document], materialized)).toHaveLength(1)
    // Outside the node's window, and a near-miss text: the real engine rejects each — so the pin
    // covers the clause SEMANTICS, not merely "it did not throw".
    expect(filterSessionEventDocuments([{ ...document, time: 1_000_000 }], materialized)).toHaveLength(0)
    expect(filterSessionEventDocuments([{ ...document, text: 'id: something-else' }], materialized)).toHaveLength(0)
  })

  it('rejects the tuple shape in the real validator (the W20 failure line)', () => {
    const tuple = [['time', 1, 2]] as unknown as readonly SessionEventResultFilter[]
    expect(() => materializeSessionEventResultFilters(tuple)).toThrow(/unknown filter kind/u)
  })
})
