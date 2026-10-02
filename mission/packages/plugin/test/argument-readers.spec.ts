/**
 * The two readers behind the tolerant declarations, at their own boundary.
 *
 * `tolerant-args.spec.ts` proves the DECLARED shapes (`oneOf`) admit the text forms through
 * the real parameter schema. This file is about the other half: what the readers do with a
 * raw argument once it arrives, including the shapes the schema can no longer refuse on their
 * behalf. The distinction matters because a plain non-JSON string is a LEGAL `oneOf` branch —
 * it is the one-item-per-line form — so "this string is not an array" is a reader decision,
 * not a schema one.
 */
import { describe, expect, it } from 'vitest'
import { childSpecs, optionalUnit, strList, structuredArg, textLines } from '../src/tools.js'

describe('structuredArg', () => {
  it('decodes the JSON text of a structure', () => {
    expect(structuredArg({ a: '["x","y"]' }, 'a')).toEqual(['x', 'y'])
    expect(structuredArg({ a: '{"k":1}' }, 'a')).toEqual({ k: 1 })
  })

  it('passes a non-JSON string through unchanged, so the reader can report it', () => {
    expect(structuredArg({ a: 'not json' }, 'a')).toBe('not json')
  })

  it('passes a non-string through untouched — a string parameter is never decoded here', () => {
    const value = ['already', 'an', 'array']
    expect(structuredArg({ a: value }, 'a')).toBe(value)
    expect(structuredArg({ a: undefined }, 'a')).toBeUndefined()
  })
})

describe('textLines', () => {
  it('takes one item per non-blank line, trimming and dropping bullets', () => {
    expect(textLines('- a\n* b\n• c\n\n   d  \n')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('strList', () => {
  it('reads the array, its JSON text, and one item per line identically', () => {
    expect(strList({ a: ['x', 'y'] }, 'a')).toEqual(['x', 'y'])
    expect(strList({ a: '["x","y"]' }, 'a')).toEqual(['x', 'y'])
    expect(strList({ a: '- x\n- y\n' }, 'a')).toEqual(['x', 'y'])
  })

  it('treats an absent argument as empty, and refuses what is neither list nor text', () => {
    expect(strList({}, 'a')).toEqual([])
    expect(() => strList({ a: 42 }, 'a')).toThrow('must be an array of strings')
    expect(() => strList({ a: { x: 1 } }, 'a')).toThrow('must be an array of strings')
  })
})

describe('childSpecs', () => {
  const body = [{ title: 'A', description: 'a', context: ['why a'] }]

  it('reads the array and its JSON text identically', () => {
    expect(childSpecs({ children: body })).toEqual(body)
    expect(childSpecs({ children: JSON.stringify(body) })).toEqual(body)
  })

  it('reads a nested context given as one item per line', () => {
    expect(childSpecs({ children: [{ title: 'A', description: 'a', context: '- why a\n- and b\n' }] }))
      .toEqual([{ title: 'A', description: 'a', context: ['why a', 'and b'] }])
  })

  it('reads a nested context given as its JSON text', () => {
    expect(childSpecs({ children: [{ title: 'A', description: 'a', context: '["why a"]' }] }))
      .toEqual([{ title: 'A', description: 'a', context: ['why a'] }])
  })

  it('treats an absent context as empty, and filters non-string array items', () => {
    expect(childSpecs({ children: [{ title: 'A', description: 'a' }] }))
      .toEqual([{ title: 'A', description: 'a', context: [] }])
    expect(childSpecs({ children: [{ title: 'A', description: 'a', context: ['why', 7] }] })[0]?.context)
      .toEqual(['why'])
  })

  it('refuses a children value that is neither an array nor JSON text, readably', () => {
    expect(() => childSpecs({ children: 'plain words' })).toThrow('must be an array')
    expect(() => childSpecs({})).toThrow('must be an array')
    expect(() => childSpecs({ children: 3 })).toThrow('must be an array')
  })

  it('refuses a malformed child with the offending index', () => {
    expect(() => childSpecs({ children: [{ description: 'a' }] })).toThrow('children[0].title')
    expect(() => childSpecs({ children: [{ title: 'A' }] })).toThrow('children[0].description')
    expect(() => childSpecs({ children: ['A'] })).toThrow('children[0] must be an object')
    expect(() => childSpecs({ children: [body[0], 'B'] })).toThrow('children[1] must be an object')
  })

  it('leaves `unit` absent when the child declares none, and carries it trimmed when it does', () => {
    // Absent means INHERIT the parent's scope, which is a different fact from "declared no scope":
    // the key must not appear as `undefined`, or `resolveChildUnit` could not tell the two apart.
    expect(childSpecs({ children: [{ title: 'A', description: 'a' }] })[0]).not.toHaveProperty('unit')
    expect(childSpecs({ children: [{ title: 'A', description: 'a', unit: '  pkg/x.ts  ' }] })[0]?.unit)
      .toBe('pkg/x.ts')
    // A blank scope is the explicit opt-OUT and reads as `null`, never as "".
    expect(childSpecs({ children: [{ title: 'A', description: 'a', unit: '   ' }] })[0]?.unit).toBeNull()
  })
})

describe('optionalUnit', () => {
  it('distinguishes "not declared" from "declared as none" from a declared scope', () => {
    expect(optionalUnit({}, 'unit')).toBeUndefined()
    expect(optionalUnit({ unit: '   ' }, 'unit')).toBeNull()
    expect(optionalUnit({ unit: ' pkg/x.ts ' }, 'unit')).toBe('pkg/x.ts')
  })

  it('treats a non-string as not declared, the schema having already refused it upstream', () => {
    expect(optionalUnit({ unit: 7 }, 'unit')).toBeUndefined()
    expect(optionalUnit({ unit: null }, 'unit')).toBeUndefined()
  })
})
