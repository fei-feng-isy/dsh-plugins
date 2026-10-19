/**
 * The start seam's contract: one adapter, two host shapes.
 *
 * WHY A TEST FILE OF ITS OWN. The two shapes are a runtime protocol, not a compile-time dependency:
 * dsh 0.2.0-rc.2 exposes `startContinuable`, the 0.2.1-rc.2 build merged it into
 * `startActivation({ delivery })`, and the published dsh is still the older one. Nothing about that
 * mapping is checked by `tsc` (both calls are structurally typed), so these are the assertions that
 * would catch a mis-mapped field — the failure mode being "mounts on the new host, then every dispatch
 * throws", which no mount smoke would reach.
 */
import { describe, expect, it } from 'vitest'
import {
  NO_START_METHOD,
  createStartAdapter,
  detectStartShape,
  type StartRequest,
} from '../src/subagentStart.js'

const signal = new AbortController().signal
const request = (overrides: Partial<StartRequest> = {}): StartRequest => ({
  provider: 'spawn',
  label: 'mission n1',
  childId: 'claim-1',
  prompt: [{ type: 'text', text: 'do the thing' }],
  parent: { id: 'parent-1' },
  deny: ['create_mission'],
  signal,
  ...overrides,
})

describe('detectStartShape', () => {
  it("reports the newer shape when the host merged startContinuable into startActivation", () => {
    expect(detectStartShape({ startActivation: () => undefined })).toBe('startActivation')
  })

  it('prefers startActivation when a host happens to expose both', () => {
    expect(detectStartShape({ startActivation: () => undefined, startContinuable: () => undefined }))
      .toBe('startActivation')
  })

  it('reports the published shape when only startContinuable exists', () => {
    expect(detectStartShape({ startContinuable: () => undefined })).toBe('startContinuable')
  })

  it('reports none for an absent or unreadable service, never a throw', () => {
    expect(detectStartShape(undefined)).toBe('none')
    expect(detectStartShape({})).toBe('none')
    expect(detectStartShape(new Proxy({}, {
      get() {
        throw new Error('service unavailable')
      },
    }))).toBe('none')
  })
})

describe('createStartAdapter — the published shape (startContinuable)', () => {
  it('calls startContinuable with the spec the old service already took, tool filter included', async () => {
    const seen: unknown[] = []
    const adapter = createStartAdapter({
      startContinuable: (spec: unknown) => {
        seen.push(spec)
        return Promise.resolve({ childId: 'claim-1', messageId: 'm1' })
      },
    })
    expect(adapter.shape).toBe('startContinuable')
    expect(adapter.carriesToolFilter).toBe(true)

    const started = await adapter.start(request())
    expect(started).toEqual({ childId: 'claim-1', messageId: 'm1' })
    expect(seen).toEqual([{
      provider: 'spawn',
      label: 'mission n1',
      childId: 'claim-1',
      request: {
        prompt: [{ type: 'text', text: 'do the thing' }],
        parent: { id: 'parent-1' },
        toolFilter: { deny: ['create_mission'] },
      },
      signal,
    }])
  })

  it('omits the filter when the deny list is empty (a materialized-empty omission, not an empty filter)', async () => {
    const seen: Array<{ request: Record<string, unknown> }> = []
    const adapter = createStartAdapter({
      startContinuable: (spec: { request: Record<string, unknown> }) => {
        seen.push(spec)
        return Promise.resolve({ childId: 'claim-1', messageId: 'm1' })
      },
    })
    await adapter.start(request({ deny: [] }))
    expect(seen[0]?.request).not.toHaveProperty('toolFilter')
  })

  it('calls the method with the service as `this` (a proxy-backed service loses `this` otherwise)', async () => {
    const service = {
      calls: 0,
      startContinuable(this: { calls: number }) {
        this.calls += 1
        return Promise.resolve({ childId: 'claim-1', messageId: 'm1' })
      },
    }
    await createStartAdapter(service).start(request())
    expect(service.calls).toBe(1)
  })
})

describe('createStartAdapter — the local 0.2.1 shape (startActivation)', () => {
  it('maps the start to startActivation with delivery=parent and NO toolFilter', async () => {
    const seen: unknown[] = []
    const adapter = createStartAdapter({
      startActivation: (spec: unknown) => {
        seen.push(spec)
        return Promise.resolve({ childId: 'claim-1', messageId: 'm2' })
      },
    })
    expect(adapter.shape).toBe('startActivation')
    // The newer start shape has no per-child filter; the caller reports that as a capability, and the
    // adapter must not pretend otherwise by sending a field the host never reads.
    expect(adapter.carriesToolFilter).toBe(false)

    const started = await adapter.start(request())
    expect(started).toEqual({ childId: 'claim-1', messageId: 'm2' })
    expect(seen).toEqual([{
      provider: 'spawn',
      label: 'mission n1',
      childId: 'claim-1',
      request: {
        prompt: [{ type: 'text', text: 'do the thing' }],
        parent: { id: 'parent-1' },
      },
      signal,
      delivery: 'parent',
    }])
  })

  it('keeps the reserved claim id when the host does not echo childId back', async () => {
    const adapter = createStartAdapter({
      startActivation: () => Promise.resolve({ messageId: 'm2' }),
    })
    expect(await adapter.start(request())).toEqual({ childId: 'claim-1', messageId: 'm2' })
  })

  it('calls the method with the service as `this`', async () => {
    const service = {
      calls: 0,
      startActivation(this: { calls: number }) {
        this.calls += 1
        return Promise.resolve({ childId: 'claim-1', messageId: 'm1' })
      },
    }
    await createStartAdapter(service).start(request())
    expect(service.calls).toBe(1)
  })
})

describe('createStartAdapter — a host with neither shape', () => {
  it('reports none and throws the documented reason on a dispatch', async () => {
    const adapter = createStartAdapter({})
    expect(adapter.shape).toBe('none')
    await expect(adapter.start(request())).rejects.toThrow(NO_START_METHOD)
  })
})
