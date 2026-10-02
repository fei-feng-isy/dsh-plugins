/**
 * The `avantfMem` wire schemas must be able to express every field the host accepts.
 *
 * Why this is a test and not a review note: the codec on each parameter runs on the way OUT
 * (the harness gateway parses args before sending), and a zod object drops unknown keys. So a
 * field missing from `src/remote.ts` is not an error anywhere — the request goes out with that
 * field silently removed, fails contract validation on the host, and the button that sent it
 * reports "N 处不合法" or, worse, succeeds with an emptied payload. Four fields have now shipped
 * that way: `contradiction_id` / `resolution` / `loser_fact_id` (the 矛盾裁决 buttons, broken for
 * two releases) and `adopt` (the 知识 tab's 「认领文件」 button, which reported 「认领完成：0 篇」).
 *
 * The PRIMARY invariant is `declared ⊇ contract`: for the five tool-backed methods, every field of
 * the contract's action union must be declared on the wire face. That is strictly stronger than
 * comparing against the client source, because a field the client sends has to be a contract field
 * to do anything at all — so covering the contract covers every present and future call site,
 * including the ones a source scan cannot see (`kbCall(label, args)` forwards a variable, and a
 * conditional spread hides its keys from a regex).
 *
 * The client-source scan is kept as a SECOND net for the UI-only methods (`openDoc`,
 * `classifySource`, `browseDir`, `kbDomains`, `kbAddDomain`), which have no contract union behind
 * them. BOTH the scan's method alternation and its expectations are derived from `descriptors`, so
 * the guard cannot drift from the face it guards.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { descriptors } from '../src/remote.js'
import { RememberUnion, RecallUnion, AdminUnion, KbUnion, QueryUnion } from '@avantf/mem-contract'

const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** JS literals that look like bare identifiers in an object body but are never keys. */
const NOT_A_KEY = new Set(['undefined', 'true', 'false', 'null'])

/** Split an object body on its TOP-LEVEL commas, ignoring commas inside strings and nesting. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, at))
      start = at + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

/**
 * The index just past the bracket that closes the one at `open`, or -1.
 *
 * Quote-aware, and treats `()[]{}` as one depth counter: the argument expression of a call mixes
 * all three (`remote.kb(cond ? {…} : {…})`), and only the matching close tells us where it ends.
 */
function matchBracket(source: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let at = open; at < source.length; at += 1) {
    const char = source[at]
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }
  return -1
}

/**
 * Every key an expression can put on the wire.
 *
 * Reads whole properties — rather than scanning for identifiers — so an identifier used as a VALUE
 * (`limit: MEMORY_PAGE_SIZE`) is not mistaken for a field name. Recurses into a spread's expression
 * (`...(adopt === true ? { adopt: true } : {})` is how the client sends an optional flag) and so
 * picks up both branches of a ternary argument. Deliberately does NOT descend into a nested object
 * VALUE: the wire faces are flat, and treating an inner literal's keys as top-level fields would
 * invent requirements. If a face ever needs nesting, this is the line to revisit.
 */
function collectKeys(expression: string, out: Set<string>): void {
  let quote: string | null = null
  for (let at = 0; at < expression.length; at += 1) {
    const char = expression[at]
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char !== '{') continue
    const end = matchBracket(expression, at)
    if (end === -1) return
    for (const property of splitTopLevel(expression.slice(at + 1, end - 1))) {
      const spread = /^\s*\.\.\.([\s\S]*)$/.exec(property)
      if (spread !== null) { collectKeys(spread[1]!, out); continue }
      const explicit = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(property)
      const shorthand = explicit === null ? /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(property) : null
      const key = explicit?.[1] ?? shorthand?.[1]
      if (key !== undefined && !NOT_A_KEY.has(key)) out.add(key)
    }
    at = end - 1
  }
}

/**
 * Every method the wire face declares, longest name first so `kbDomains` is never matched as `kb`.
 *
 * DERIVED from `descriptors`, never hand-listed: this scan is the SECOND net for the methods with no
 * contract union behind them (`openDoc` / `classifySource` / `browseDir` / `kbDomains` /
 * `kbAddDomain`), and a hand-written alternation is exactly what let `classifySource` and `browseDir`
 * go unguarded — the miss had been written down below as an expectation. Deriving means a method
 * added to the face enters the scan (and its own client call site is required) automatically.
 */
const WIRE_METHODS: readonly string[] = [...descriptors]
  .map(descriptor => descriptor.method)
  .sort((left, right) => right.length - left.length)

const CALL = new RegExp(`remote\\.(${WIRE_METHODS.join('|')})\\(`, 'gu')

/** Every key sent through one `remote.<method>(…)` call, whatever shape the argument takes. */
function sentFields(source: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const match of source.matchAll(CALL)) {
    const open = match.index + match[0].length - 1
    const end = matchBracket(source, open)
    if (end === -1) continue
    const keys = found.get(match[1]!) ?? new Set<string>()
    collectKeys(source.slice(open + 1, end - 1), keys)
    found.set(match[1]!, keys)
  }
  return found
}

/** The declared keys of one descriptor's `args` object (zod v4 keeps the shape on `def`). */
function declaredFields(method: string): string[] {
  const descriptor = descriptors.find(candidate => candidate.method === method)
  if (descriptor === undefined) throw new Error(`no descriptor for ${method}`)
  const parameter = descriptor.parameters[0]
  if (parameter === undefined) throw new Error(`${method} declares no parameter`)
  const schema = (parameter.codec as unknown as { schema: { def: { shape?: Record<string, unknown> } } }).schema
  const shape = schema.def.shape
  if (shape === undefined) throw new Error(`${method}'s args schema is not an object`)
  return Object.keys(shape)
}

/**
 * Every field a contract schema accepts, through zod's OWN converter.
 *
 * `z.toJSONSchema` rather than a hand walk of `def.options`/`def.shape`: one mechanism, the same one
 * the tool faces use, so a zod internal that moves breaks the derivation loudly here instead of
 * quietly reporting an empty field set (which would make every assertion below pass vacuously — the
 * `expect(…size).toBeGreaterThan(0)` guard in the describe block is what catches that).
 */
function contractFields(schema: z.ZodType): Set<string> {
  const out = new Set<string>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const properties = record['properties']
    if (properties !== null && typeof properties === 'object') {
      for (const key of Object.keys(properties as Record<string, unknown>)) out.add(key)
    }
    for (const branch of ['anyOf', 'oneOf', 'allOf']) {
      const list = record[branch]
      if (Array.isArray(list)) for (const item of list) walk(item)
    }
  }
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
  return out
}

/** The five methods that mirror an agent tool, and the union each one carries. */
const TOOL_FACES: [method: string, union: z.ZodType][] = [
  ['remember', RememberUnion],
  ['recall', RecallUnion],
  ['admin', AdminUnion],
  ['kb', KbUnion],
  ['query', QueryUnion],
]

describe('remote wire schemas', () => {
  const sent = sentFields(CLIENT_SOURCE)

  it('found the client call sites it is supposed to guard', () => {
    // A regex that silently matches nothing would make every case below vacuously pass. Both sides
    // are DERIVED from `descriptors`, so a declared method the client never calls fails here rather
    // than sitting silently outside the guard — which is how `classifySource`/`browseDir` hid.
    expect([...sent.keys()].sort()).toEqual([...WIRE_METHODS].sort())
    expect(sent.get('admin')?.size ?? 0).toBeGreaterThanOrEqual(8)
    // `kb`'s literal call sites are few — most of its traffic goes through the `kbCall`/`ingestCall`
    // wrappers, which is exactly why the contract-superset invariant above is the primary one.
    expect([...(sent.get('kb') ?? [])].sort()).toEqual(['action', 'adopt', 'doc_id', 'dry_run', 'limit', 'offset', 'overwrite'])
  })

  it('reads a non-empty field set out of every contract union', () => {
    // The vacuity guard for `contractFields`: an empty set would satisfy "declared ⊇ contract" for
    // ANY wire face, so the primary invariant below would be worthless without this.
    for (const [method, union] of TOOL_FACES) {
      expect(contractFields(union).size, method).toBeGreaterThan(3)
    }
  })

  it.each(TOOL_FACES.map(([method]) => method))(
    '%s declares every field the contract accepts',
    (method) => {
      const union = TOOL_FACES.find(([name]) => name === method)![1]!
      const declared = new Set(declaredFields(method))
      const missing = [...contractFields(union)].filter(field => !declared.has(field)).sort()
      expect(missing).toEqual([])
    },
  )

  it.each(WIRE_METHODS)(
    '%s declares every field the client source sends',
    (method) => {
      const declared = new Set(declaredFields(method))
      const sentHere = [...(sent.get(method) ?? new Set<string>())].sort()
      expect(sentHere.filter(field => !declared.has(field))).toEqual([])
    },
  )

  it('pins the fields that shipped undeclared (B1 + adopt regressions)', () => {
    for (const field of ['contradiction_id', 'resolution', 'loser_fact_id']) {
      expect(declaredFields('admin')).toContain(field)
    }
    expect(declaredFields('kb')).toContain('adopt')
    // The client sends this one through a conditional spread, which the old scan could not see.
    expect(sent.get('kb')).toContain('adopt')
  })
})
