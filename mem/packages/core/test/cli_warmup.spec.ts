/**
 * The CLI's model-warmup table is cross-checked against the command list the CLI itself advertises.
 *
 * WHY A SOURCE SCAN (`mem/packages/plugin/test/no_rerank.spec.ts` is the precedent): the CLI entry
 * cannot be imported — it calls `main()` at module scope, and importing another package's source from
 * this one is outside this tsconfig's `rootDir` — so the guard reads the entry as text. What it pins
 * is DATA, not implementation: `COMMAND_MODEL_WARMUP` in `cli/src/index.ts` must classify exactly the
 * commands the usage banner advertises, with the rule this file states as the SPEC.
 *
 * The failure mode it removes is silent: a command added to the CLI but not classified here means the
 * model is never warmed for it (`ask` on a cold cache quietly answers from the degraded legs), and a
 * pure-DB command classified here pays a model download for nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const CLI_SOURCE = readFileSync(new URL('../../cli/src/index.ts', import.meta.url), 'utf8')

/** What one command needs: the model always, the model conditionally, or never. */
type WarmupRule = 'always' | 'vectors-fix' | 'kb-write' | 'write-unless-dry-run' | 'never'

/**
 * THE SPEC (hand-written on purpose — it is the requirement, not a copy of the implementation):
 * every command the CLI advertises, and whether its invocation touches the semantic path.
 *
 * `related` / `reason` / `chain` / `contradict` are pure entity-graph reads
 * (`MemoryStore.related` never encodes a query), so they must NOT warm.
 */
const SPEC: Readonly<Record<string, WarmupRule>> = {
  add: 'always',
  ask: 'always',
  chain: 'never',
  contradict: 'never',
  edit: 'always',
  helpful: 'never',
  list: 'never',
  maintenance: 'never',
  pin: 'never',
  probe: 'always',
  query: 'always',
  reason: 'never',
  related: 'never',
  remove: 'never',
  resolve: 'never',
  restore: 'never',
  search: 'always',
  show: 'never',
  stats: 'never',
  trust: 'never',
  unhelpful: 'never',
  unpin: 'never',
  archive: 'never',
  kb: 'kb-write',
  // `merge` writes every imported fact through the store's add path (which indexes when the model
  // is available); `--dry-run` is a plan-only read and must not warm anything.
  merge: 'write-unless-dry-run',
  // `import` is the document variant of the same write path; `export` only reads stored rows.
  export: 'never',
  import: 'write-unless-dry-run',
  vectors: 'vectors-fix',
}

/** A block of the entry's source, from one marker to the next. */
function slice(from: string, to: string): string {
  const start = CLI_SOURCE.indexOf(from)
  const end = CLI_SOURCE.indexOf(to, start + from.length)
  expect(start, `the entry must contain ${from}`).toBeGreaterThanOrEqual(0)
  expect(end, `the entry must contain ${to}`).toBeGreaterThan(start)
  return CLI_SOURCE.slice(start, end)
}

/**
 * Every command the CLI DECLARES, from the three places it can declare one: the usage banner (the
 * CLI's own "here is the whole surface" list), the main dispatch's `case` labels, and the recall
 * template table. A command missing from any one of them still has to be classified, so the union is
 * what the spec is checked against.
 */
function advertisedCommands(): string[] {
  const banner = /usage: avantf-mem <([^>]+)>/.exec(CLI_SOURCE)
  expect(banner, 'the CLI usage banner must exist').not.toBeNull()
  const fromBanner = (banner?.[1] ?? '')
    .split('|')
    .map((token) => token.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name !== '')
  const fromSwitch = [...slice('async function main(', 'function readStdin(')
    .matchAll(/^ {6}case '([a-z_]+)':/gmu)].map((match) => match[1] as string)
  const fromRecall = [...slice('const RECALL_TEXT_CMDS', 'const COMMAND_MODEL_WARMUP')
    .matchAll(/^ {2}([a-z_]+): \{/gmu)].map((match) => match[1] as string)
  expect(fromSwitch.length).toBeGreaterThan(15)
  expect(fromRecall.length).toBe(4)
  return [...new Set([...fromBanner, ...fromSwitch, ...fromRecall])].sort()
}

/** The `COMMAND_MODEL_WARMUP` literal, as `name → rule` (the object literal is plain data). */
function warmupTable(): Record<string, string> {
  const block = slice('const COMMAND_MODEL_WARMUP', '\n}\n')
  const table: Record<string, string> = {}
  for (const match of block.matchAll(/^ {2}([a-z_]+): '([a-z-]+)',/gmu)) {
    table[match[1] as string] = match[2] as string
  }
  expect(Object.keys(table).length, 'the warmup table must be parseable').toBeGreaterThan(0)
  return table
}

describe('the CLI model-warmup table covers the advertised command surface', () => {
  it('classifies exactly the commands the CLI advertises (a new command must be classified)', () => {
    // Both directions: an advertised command the SPEC misses fails here, and so does a SPEC entry for
    // a command that no longer exists — the spec cannot rot into a superset either.
    expect(advertisedCommands()).toEqual(Object.keys(SPEC).sort())
  })

  it('matches the SPEC for every command that needs the model, and leaves the rest to the default', () => {
    const expected = Object.fromEntries(
      Object.entries(SPEC).filter(([, rule]) => rule !== 'never'),
    )
    // Deep equality catches a missing entry AND a wrong rule — and, because "never" commands are
    // excluded, an entry added for a pure-DB command (a download for nothing) is a failure too.
    expect(warmupTable()).toEqual(expected)
  })

  it('is the table `needsModels` actually applies (not a second list beside a switch)', () => {
    expect(slice('function needsModels(', '\n}\n')).toContain('COMMAND_MODEL_WARMUP[cmd]')
  })

  it('skips warmup for `merge`/`import --dry-run` only (the write path still needs the model)', () => {
    const body = slice('function needsModels(', '\n}\n')
    // The rule's application, not a restatement of the command list: both commands are classified
    // above, and this is the one place that turns "write unless dry-run" into the actual boolean.
    expect(SPEC.merge).toBe('write-unless-dry-run')
    expect(SPEC.import).toBe('write-unless-dry-run')
    expect(body).toContain("rule === 'write-unless-dry-run'")
    expect(body).toContain("!rest.includes('--dry-run')")
  })
})
