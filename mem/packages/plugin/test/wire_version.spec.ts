/**
 * The mem wire revision, and the two UI payloads both halves now name from the contract.
 *
 * WHY THE REVISION IS TESTED AT ALL. The marker only pays for itself if it actually rides every
 * answer and if the client's reading of it is the one described: absent = "an older host", a number
 * below a method's introduction = "that method cannot exist there, do not send the call". Mission
 * paid this tuition with a measured 404; this spec is the mem half of the same discipline.
 *
 * THE CROSS-END PINS ARE TYPE-LEVEL, ON PURPOSE. `DomainCatalog` (host store + host wire + picker)
 * and `OpenOutcome` (host launcher + host wire + panel) each come from `@avantf/mem-contract`; the
 * `Equal<…>` pins below fail to COMPILE (in `pnpm typecheck:dsh`) if either half re-introduces a
 * hand-copied lookalike — a runtime `toEqual` between two literals would not. The one runtime pin is
 * the real launcher's actual returned object.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { WIRE_VERSION, wireErr, wireOk } from '../src/remote.js'
import { hostSkew, hostSupports, staleHostText, transportHint } from '../src/client/wire.js'
import { openDocumentPath } from '../src/open.js'
import type { DomainCatalog, OpenOutcome, RemoteEnvelope } from '@avantf/mem-contract'
import type { KnowledgeStore } from '@avantf/mem'
import type { AvantfMemGateway } from '../src/index.js'

/** The standard strict type equality; `Equal<A, B>` is false when either side is a lookalike. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// Host store → contract (cross-package: `@avantf/mem`'s real built declarations).
type _CatalogReturn = Expect<Equal<ReturnType<KnowledgeStore['domainCatalog']>, DomainCatalog>>
type _AddDomainReturn = Expect<Equal<ReturnType<KnowledgeStore['addDomain']>, DomainCatalog>>
// Host launcher → contract.
type _LaunchReturn = Expect<Equal<ReturnType<typeof openDocumentPath>, OpenOutcome>>
// Host WIRE declarations → contract: the gateway answers these payloads, so the panel's
// `callRemote<DomainCatalog>` / `callRemote<OpenOutcome>` read the same type the host promised.
type _DomainsWire = Expect<Equal<Awaited<ReturnType<AvantfMemGateway['kbDomains']>>, RemoteEnvelope<DomainCatalog>>>
type _AddDomainWire = Expect<Equal<Awaited<ReturnType<AvantfMemGateway['kbAddDomain']>>, RemoteEnvelope<DomainCatalog>>>
type _OpenWire = Expect<Equal<Awaited<ReturnType<AvantfMemGateway['openDoc']>>, RemoteEnvelope<OpenOutcome>>>

const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

describe('the wire revision', () => {
  it('is a positive integer, pinned so a face change is a deliberate edit', () => {
    expect(Number.isInteger(WIRE_VERSION)).toBe(true)
    expect(WIRE_VERSION).toBeGreaterThanOrEqual(1)
    // Revision 1 is the first marker: the face is the ten methods that all predate it, so NOTHING is
    // gated yet. Raising this number without adding/removing a descriptor is a mistake.
    expect(WIRE_VERSION).toBe(1)
  })

  it('is stamped on both envelopes, success and failure alike', () => {
    // The client learns the host's revision from whichever call answered first, so a failure that
    // skipped the stamp would blind it exactly when the host is misbehaving.
    expect(wireOk({ hits: [] })).toEqual({ ok: true, value: { hits: [] }, wire: WIRE_VERSION })
    expect(wireOk(undefined)).toEqual({ ok: true, value: undefined, wire: WIRE_VERSION })
    expect(wireErr({ ok: false, error: 'boom' })).toEqual({ ok: false, error: 'boom', wire: WIRE_VERSION })
    expect(wireErr({ ok: false, error: '参数不合法', violations: ['query: Required'] }))
      .toEqual({ ok: false, error: '参数不合法', violations: ['query: Required'], wire: WIRE_VERSION })
  })
})

describe('the client-side gate', () => {
  it('a host revision at or above the method lets the call through', () => {
    expect(hostSupports(WIRE_VERSION, WIRE_VERSION)).toBe(true)
    expect(hostSupports(WIRE_VERSION + 1, WIRE_VERSION)).toBe(true)
  })

  it('a host revision below the method (or none observed yet) does not', () => {
    expect(hostSupports(WIRE_VERSION - 1, WIRE_VERSION)).toBe(false)
    expect(hostSupports(undefined, WIRE_VERSION)).toBe(false)
  })

  it('names the missing registration and the remedy when it refuses to send', () => {
    const text = staleHostText(WIRE_VERSION - 1, WIRE_VERSION, 'kb.someNewCall')
    expect(text).toContain('旧版本')
    expect(text).toContain('kb.someNewCall')
    expect(text).toContain('没有发出去')
    expect(text).toContain('重启 dsh web')
  })

  it('turns a gateway 404 into "the two halves are out of step", and leaves other failures alone', () => {
    const notFound = transportHint(new Error('Request failed with status 404'))
    expect(notFound).toContain('没有注册这个接口')
    expect(notFound).toContain('重启 dsh web')
    expect(notFound).toContain('404') // the original words stay available for diagnosis
    expect(transportHint(new Error('SQLITE_BUSY'))).toBe('SQLITE_BUSY')
    expect(transportHint('plain text')).toBe('plain text')
  })
})

describe('hostSkew', () => {
  it('is quiet when the two halves agree', () => {
    expect(hostSkew(WIRE_VERSION)).toBeUndefined()
  })

  it('reads an absent marker as "an older host", never as a shape failure', () => {
    const note = hostSkew(undefined)
    expect(note).toContain('没有回报 wire 版本')
    expect(note).toContain('重启 dsh web')
    expect(note).toContain(`wire=${String(WIRE_VERSION)}`)
  })

  it('names both numbers when the host reports a revision this client does not know', () => {
    const note = hostSkew(WIRE_VERSION + 1)
    expect(note).toContain(`wire 版本是 ${String(WIRE_VERSION + 1)}`)
    expect(note).toContain(`只认识 ${String(WIRE_VERSION)}`)
  })
})

describe('the shared UI payloads', () => {
  it('the real launcher returns exactly the contract shape', () => {
    const launched: string[] = []
    const outcome = openDocumentPath('/tmp/avantf-wire-pin.md', 'file', process.execPath, {
      platform: 'linux',
      env: {},
      spawn: (command, args) => { launched.push(`${command} ${args.join(' ')}`); return { unref: () => {} } },
      warn: () => {},
    })
    expect(outcome).toEqual({ path: '/tmp/avantf-wire-pin.md', target: 'file', opener: process.execPath })
    expect(launched).toEqual([`${process.execPath} /tmp/avantf-wire-pin.md`])
  })

  it('the client names the contract types instead of re-declaring them', () => {
    // The mirror is what the review found: a local `interface DomainCatalog` / `{path,opener}` copy
    // drifts, then a render body dereferences a field the host stopped sending. A local literal here
    // would re-open that hole even though the shared type still exists.
    expect(CLIENT_SOURCE).not.toMatch(/interface\s+DomainCatalog\b/)
    expect(CLIENT_SOURCE).not.toMatch(/\{\s*path:\s*string;\s*opener:\s*string\s*\}/)
    expect(CLIENT_SOURCE).toMatch(/callRemote<DomainCatalog>/)
    expect(CLIENT_SOURCE).toMatch(/callRemote<OpenOutcome>/)
  })
})
