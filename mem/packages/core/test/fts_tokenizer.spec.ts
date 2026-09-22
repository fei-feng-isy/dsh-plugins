/**
 * The FTS tokenizer a table was ACTUALLY built with.
 *
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` never rebuilds an existing table, so a database carries the
 * tokenizer of the SQLite build that created it — possibly another machine, possibly years ago. The
 * query builder used to ask the CURRENT build what it would create today and build MATCH expressions
 * for that, which is silent zero recall in both directions: a trigram table cannot match a
 * whole-token phrase, and a unicode61 table cannot match a 3-gram. Neither raises an error, so the
 * store just stops finding things.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setRetrievalLogger } from '@avantf/mem-core'
import { openSqlite } from '../src/db/sqlite.js'
import type { Db } from '../src/db/port.js'
import {
  buildFtsQuery,
  detectFtsTokenizer,
  reportFtsTokenizerDrift,
  trigramAvailable,
} from '../src/db/tokenizer.js'

let warnings: string[]

beforeEach(() => {
  warnings = []
  setRetrievalLogger({
    info(): void {},
    warn(message: string): void { warnings.push(message) },
    error(): void {},
  })
})
afterEach(() => setRetrievalLogger(undefined))

/** An in-memory database holding one FTS table created with `ddl`. */
function dbWith(table: string, ddl: string): Db {
  const db = openSqlite(':memory:')
  db.exec(ddl)
  return db
}

describe('detectFtsTokenizer', () => {
  it('reads trigram out of the table DDL', () => {
    const db = dbWith('t', "CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram')")
    expect(detectFtsTokenizer(db, 't')).toBe('trigram')
    db.close()
  })

  it('reads unicode61 out of the table DDL', () => {
    const db = dbWith('t', "CREATE VIRTUAL TABLE t USING fts5(content, tokenize='unicode61')")
    expect(detectFtsTokenizer(db, 't')).toBe('unicode61')
    db.close()
  })

  it('treats a missing tokenize= as FTS5 own default, and a missing table as unknown', () => {
    const db = dbWith('t', 'CREATE VIRTUAL TABLE t USING fts5(content)')
    expect(detectFtsTokenizer(db, 't')).toBe('unicode61')
    expect(detectFtsTokenizer(db, 'nope')).toBeNull()
    db.close()
  })

  it('reports what the DATABASE has, not what this build would create', () => {
    // The whole point: the two disagree whenever a database moves between machines or SQLite builds,
    // and the disagreement used to be resolved in favour of the RUNNING build.
    const db = dbWith('t', "CREATE VIRTUAL TABLE t USING fts5(content, tokenize='unicode61')")
    expect(detectFtsTokenizer(db, 't')).toBe('unicode61')
    // On a trigram-capable build this is the case that used to produce a trigram query for a
    // unicode61 table, i.e. zero recall with no error.
    if (trigramAvailable()) expect(detectFtsTokenizer(db, 't')).not.toBe('trigram')
    db.close()
  })
})

describe('buildFtsQuery per tokenizer', () => {
  it('emits 3-grams for a trigram table and whole tokens for a unicode61 one', () => {
    // Each of these is a MISS against the other kind of table — which is why the convention has to
    // come from the table, not from the process.
    expect(buildFtsQuery('内存回收', 'trigram')).toBe('"内存回" OR "存回收"')
    expect(buildFtsQuery('内存回收', 'unicode61')).toBe('"内存回收"')
  })

  it('finds the row with the table convention and NOTHING with the other one', () => {
    // A unicode61 table, so the case does not depend on whether this SQLite build has trigram.
    const db = dbWith('t', "CREATE VIRTUAL TABLE t USING fts5(content, tokenize='unicode61')")
    db.prepare('INSERT INTO t(content) VALUES (?)').run('内核的内存回收路径')
    const detected = detectFtsTokenizer(db, 't')
    expect(detected).toBe('unicode61')
    const count = (query: string): number =>
      db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t WHERE t MATCH ?').get(query)!.n

    // unicode61 keeps a CJK run as ONE token, so the whole phrase is the query that matches.
    expect(count(buildFtsQuery('内核的内存回收路径', 'unicode61')!)).toBe(1)
    // What a trigram-capable build emitted before detection: 3-gram phrases, which this table cannot
    // match — zero rows and no error anywhere. That is the silent failure detection removes.
    const trigramStyle = buildFtsQuery('内核的内存回收路径', 'trigram')!
    expect(trigramStyle).toContain(' OR ')
    expect(count(trigramStyle)).toBe(0)
    db.close()
  })
})

describe('reportFtsTokenizerDrift', () => {
  it('warns only when the table is weaker than this build could give it', () => {
    // A trigram table read by a build without trigram support loses nothing — the queries are built
    // for the table that exists — so it must not produce noise.
    reportFtsTokenizerDrift('drift-a', 'facts_fts', 'trigram', null)
    expect(warnings).toEqual([])
    // A unicode61 table on a trigram-capable build IS a real, invisible recall limitation.
    reportFtsTokenizerDrift('drift-b', 'facts_fts', 'unicode61', 'kb_reindex')
    if (trigramAvailable()) {
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('unicode61')
      expect(warnings[0]).toContain('kb_reindex')
    } else {
      expect(warnings).toEqual([])
    }
    // Nothing to say about a table that does not exist yet.
    reportFtsTokenizerDrift('drift-c', 'facts_fts', null, null)
    expect(warnings.length).toBeLessThanOrEqual(1)
  })

  it('says it once per store, however many times the database is opened', () => {
    reportFtsTokenizerDrift('drift-once', 'facts_fts', 'unicode61', null)
    const after = warnings.length
    reportFtsTokenizerDrift('drift-once', 'facts_fts', 'unicode61', null)
    expect(warnings).toHaveLength(after)
  })
})
