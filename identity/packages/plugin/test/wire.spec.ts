/**
 * The wire face: every field the browser half SENDS is declared, and every schema the host projects
 * survives `z.toJSONSchema` (the startup compatibility gate projects the real face through it, so a
 * schema that cannot be projected makes a healthy host read as an incompatible one).
 *
 * This is the invariant the sibling trees paid for twice: a `strict` codec drops an undeclared key
 * SILENTLY, so a missing field is not an error — it is a request that arrives empty. The check reads
 * schemas through zod's PUBLIC shape (`def.shape`), never its private implementation.
 */
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { clientContribution, descriptors, hostContribution, NAMESPACE, PACKAGE } from '../src/wire.js'

/** The fields each method's caller actually sends (mirrors `src/client/`). */
const SENT: Record<string, readonly string[]> = {
  status: ['locale'],
  listPresets: [],
  readProfile: [],
  writeProfileFile: ['name', 'text'],
  applyPreset: ['id', 'locale'],
  saveAsPreset: ['id', 'locale'],
  readPreset: ['id', 'locale'],
  writePresetFile: ['id', 'name', 'text', 'locale'],
  deletePreset: ['id'],
}

interface CodecLike {
  readonly mode?: string
  readonly typeSymbol?: string
  readonly schema?: { readonly def?: { readonly shape?: Record<string, unknown> } }
}

interface DescriptorLike {
  readonly method: string
  readonly service: string
  readonly namespace: string
  readonly invocation?: { readonly kind?: string }
  readonly parameters?: readonly { readonly name: string; readonly codec?: CodecLike }[]
}

const all = descriptors as unknown as readonly DescriptorLike[]

/**
 * Whether this method takes NO business argument.
 *
 * The host methods `listPresets()` / `readProfile()` take none, and the gateway prefers the descriptor
 * derived from the host method's SIGNATURE: declaring an empty `args` parameter made every call fail
 * with `gateway/arguments-invalid` (`unexpected "args"`) in the live profile. Arity is therefore part
 * of the wire contract, not a detail — measured, then pinned here.
 */
const noArgs = (method: string): boolean => (SENT[method] ?? []).length === 0

describe('the Remote descriptors', () => {
  it('declare the arity the host method has: one args object, or none at all', () => {
    for (const descriptor of all) {
      expect(descriptor.service, descriptor.method).toBe(NAMESPACE)
      expect(descriptor.namespace, descriptor.method).toBe(NAMESPACE)
      expect(descriptor.invocation?.kind, descriptor.method).toBe('direct')
      if (noArgs(descriptor.method)) {
        expect(descriptor.parameters ?? [], descriptor.method).toHaveLength(0)
        continue
      }
      expect(descriptor.parameters, descriptor.method).toHaveLength(1)
      expect(descriptor.parameters?.[0]?.name, descriptor.method).toBe('args')
      expect(descriptor.parameters?.[0]?.codec?.mode, descriptor.method).toBe('strict')
    }
  })

  it('publish exactly the methods the page calls', () => {
    expect(all.map((descriptor) => descriptor.method)).toEqual(Object.keys(SENT))
  })

  it('declare a strict codec type symbol for every parameter', () => {
    for (const descriptor of all) {
      if (noArgs(descriptor.method)) continue
      const codec = descriptor.parameters?.[0]?.codec
      expect(codec?.typeSymbol, descriptor.method).toBe(`${PACKAGE}#${NAMESPACE}/${descriptor.method}:args`)
    }
  })

  it('declares every field the caller sends (declared ⊇ sent)', () => {
    for (const descriptor of all) {
      const shape = descriptor.parameters?.[0]?.codec?.schema?.def?.shape ?? {}
      const declared = new Set(Object.keys(shape))
      for (const field of SENT[descriptor.method] ?? []) {
        // A `strict` codec drops an undeclared key silently — that is the failure this asserts against.
        expect(declared.has(field), `${descriptor.method} must declare "${field}"`).toBe(true)
      }
    }
  })

  it('projects every args schema through the host JSON-Schema projector', () => {
    for (const descriptor of all) {
      const schema = descriptor.parameters?.[0]?.codec?.schema
      if (noArgs(descriptor.method)) {
        expect(schema, descriptor.method).toBeUndefined()
        continue
      }
      expect(schema, descriptor.method).toBeDefined()
      // `.optional()` projects; `z.union([z.undefined(), X])` throws "Undefined cannot be represented".
      expect(() => z.toJSONSchema(schema as never, { io: 'input' }), descriptor.method).not.toThrow()
    }
  })
})

describe('the contributions', () => {
  it('name this package and both faces', () => {
    const host = hostContribution as unknown as { package?: string; face?: string; invocations?: readonly unknown[] }
    const client = clientContribution as unknown as { package?: string; descriptors?: readonly unknown[] }
    expect(host.package).toBe(PACKAGE)
    expect(host.face).toBe('host')
    expect(host.invocations).toHaveLength(all.length)
    expect(client.package).toBe(PACKAGE)
    expect(client.descriptors).toHaveLength(all.length)
  })

  it('declare a schema name for every args and result slot', () => {
    const host = hostContribution as unknown as { schemas?: readonly { name?: string }[] }
    const names = new Set((host.schemas ?? []).map((entry) => entry.name))
    for (const descriptor of all) {
      // A method with no parameters has no args slot to declare; the result slots are named below.
      if (!noArgs(descriptor.method)) expect(names.has(`${descriptor.method}args`), `${descriptor.method}args`).toBe(true)
    }
    for (const name of ['statusResult', 'profileResult', 'presetResult', 'writeResult']) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it('publish the service model the client mount reads', () => {
    const host = hostContribution as unknown as {
      model?: { services?: readonly { key?: string; exportName?: string }[]; events?: readonly string[]; objects?: readonly string[] }
    }
    expect(host.model?.services?.some((service) => service.key === NAMESPACE && service.exportName === NAMESPACE)).toBe(true)
    expect(host.model?.events).toEqual([])
    expect(host.model?.objects).toEqual([])
  })
})
