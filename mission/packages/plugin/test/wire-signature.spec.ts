/**
 * The wire descriptors and the host methods must agree PARAMETER BY PARAMETER.
 *
 * The gateway never compares a descriptor against the method it is about to call: it builds the
 * positional argument list from `descriptor.parameters` (in descriptor order, plus the stream
 * cancellation signal), then `Reflect.apply`s it onto the method
 * (`dsh-api-gateway/lib/index.js:745-757`). A hand-written descriptor is therefore one reorder
 * away from calling `detail(nodeId, args)` while the method still reads `detail(args)`: the call
 * resolves, the RPC returns `ok`, and the panel shows an empty tree or another session's mission —
 * "RPC all green, data wrong", the most silent single point in this plugin's contract. Nothing in
 * the type system connects the two declarations (`descriptors` is a hand-written array and the
 * remote methods take plain object arguments), so a test is the only place the invariant exists.
 *
 * This is the static half: it reads `descriptors` from `src/wire.ts` and recovers each host
 * method's own parameter names from `Function.prototype.toString()`, then asserts they line up
 * with the descriptor's wire fields one for one — for EVERY invocation (snapshot / detail / result /
 * delete / cleanFinished / resolveExecutorSession / watch), which the existing wire assertions do not
 * do (they only count the invocations and check that `watch` carries `mode: 'stream'`).
 *
 * The dynamic half — mounting a real `@deepseek-ai/dsh-typert-registry` and calling the six
 * methods through a gateway client — is deliberately NOT mocked here. The gateway is not
 * resolvable from this repo's tree at all (`@deepseek-ai/dsh-api-gateway` is not a peer or a
 * devDependency; it exists only inside the installed dsh), and its client half speaks HTTP +
 * WebSocket to a live dsh (`dsh-api-gateway/lib/client.js` opens `http://dsh.internal` and a
 * `WebSocket`), while the host service binds through `ctx.inject(['connection'])` and
 * `['connection', 'webServer']`. A hand-rolled in-process fake would encode this same
 * expectation and prove nothing about the real gateway, so the real call belongs to a live
 * profile, not a Node unit test.
 */
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { AvantfMissionHost } from '../src/host.js'
import { descriptors } from '../src/wire.js'

/** Split on top-level commas, so a default value or generic can never be mistaken for a boundary. */
function splitParameters(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** The identifier a single formal parameter declares, with `...`, `?`, a default and a type stripped. */
function parameterName(parameter: string): string | undefined {
  const withoutRest = parameter.replace(/^\.\.\./u, '')
  const withoutDefault = withoutRest.split('=')[0] ?? ''
  const withoutType = withoutDefault.split(':')[0] ?? ''
  const name = withoutType.replace(/\?$/u, '').trim()
  return /^[A-Za-z_$][\w$]*$/u.test(name) ? name : undefined
}

/** The formal parameter names of one method, read back out of its own source text. */
function formalParameters(method: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  if (open === -1) return []
  let depth = 0
  let close = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return []
  return splitParameters(source.slice(open + 1, close))
    .map(parameterName)
    .filter((name): name is string => name !== undefined)
}

/** The host method a descriptor names, by its own `method` field. */
function hostMethod(descriptor: InvocationDescriptor): (...args: never[]) => unknown {
  const prototype = AvantfMissionHost.prototype as unknown as Record<string, unknown>
  const method = prototype[descriptor.method]
  if (typeof method !== 'function') {
    throw new Error(`no host method ${descriptor.method} on AvantfMissionHost`)
  }
  return method as (...args: never[]) => unknown
}

/** The ordered parameter names the gateway will pass: the wire fields, then the cancellation signal. */
function expectedParameters(descriptor: InvocationDescriptor): string[] {
  const names = descriptor.parameters.map((parameter) => parameter.wire)
  if (descriptor.cancellation !== undefined) names.push(descriptor.cancellation.parameter)
  return names
}

describe('the wire face: host method parameters match the descriptor, in order', () => {
  it('covers every invocation the host publishes', () => {
    expect(descriptors.map((descriptor) => descriptor.method)).toEqual([
      'snapshot',
      'detail',
      'result',
      'delete',
      'cleanFinished',
      'resolveExecutorSession',
      'watch',
    ])
    // The pairing below is only meaningful if every invocation is actually present.
    expect(descriptors).toHaveLength(7)
  })

  it('gives each host method exactly the positional parameters its descriptor declares', () => {
    for (const descriptor of descriptors) {
      const method = hostMethod(descriptor)
      expect(formalParameters(method), `${descriptor.method}: host method parameters`).toEqual(
        expectedParameters(descriptor),
      )
    }
  })

  it('gives every strict codec BOTH members the two host generations ask for', () => {
    // dsh 0.1.5's validator calls `codec.schema.parse(...)`; 0.1.6's registry calls `codec.create()`.
    // Each generation checks only its own member, so a codec carrying one of them makes a healthy host
    // read as incompatible — and the failure is a REFUSED mount, not a warning. Measured first in
    // @avantf/dsh-mem; this copy had drifted (it shipped `schema` only).
    const codecs = descriptors.flatMap((descriptor) => [
      ...descriptor.parameters.map((parameter) => ({ where: `${descriptor.method}.${parameter.name}`, codec: parameter.codec })),
      { where: `${descriptor.method}.result`, codec: descriptor.result },
    ])
    expect(codecs.length).toBeGreaterThan(0)
    for (const { where, codec } of codecs) {
      const strict = codec as unknown as { mode?: string; schema?: unknown; create?: () => unknown }
      expect(strict.mode, `${where}: mode`).toBe('strict')
      expect(strict.schema, `${where}: schema`).toBeDefined()
      expect(typeof strict.create, `${where}: create()`).toBe('function')
      // The two members must describe the SAME schema, or the generations would validate differently.
      expect(strict.create?.(), `${where}: create() returns schema`).toBe(strict.schema)
    }
  })

  it('carries the single `args` object as the only business parameter, and signal only as cancellation', () => {
    for (const descriptor of descriptors) {
      // Every wire method takes one JSON object named `args`; a second business parameter would be a
      // positional argument the gateway would pass but the host signature above does not have.
      expect(descriptor.parameters.map((parameter) => parameter.wire), descriptor.method).toEqual(['args'])
      expect(descriptor.parameters[0]?.source).toBe('json')
      if (descriptor.mode === 'stream') {
        expect(descriptor.cancellation).toEqual({ parameter: 'signal' })
      } else {
        expect(descriptor.cancellation).toBeUndefined()
      }
    }
  })
})
