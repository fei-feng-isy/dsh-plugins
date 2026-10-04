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
import { setRetrievalLogger } from '@avantf/mem-retrieval'
import { openSqlite } from '../src/db/sqlite.js'
import type { Db } from '../src/db/port.js'
import {
  MAX_FTS_PHRASES,
  buildFtsQuery,
  detectFtsTokenizer,
  likeSubstring,
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


describe('buildFtsQuery is bounded', () => {
  it('dedupes repeated trigrams and caps the phrase count', () => {
    // A long CJK run repeats its trigrams, and `"abc" OR "abc"` is exactly `"abc"`: the duplicates cost
    // `MATCH` time and buy nothing. The cap is the second line of defence behind the contract's
    // `MAX_QUERY_CHARS` — it bounds the mission at a number the tokenizer owns.
    const long = '这是一段足够长的中文查询'.repeat(40)
    const built = buildFtsQuery(long, 'trigram')
    expect(built).not.toBeNull()
    const phrases = (built ?? '').split(' OR ')
    expect(phrases.length).toBeLessThanOrEqual(MAX_FTS_PHRASES)
    // No duplicates survive, and every phrase is still a quoted trigram.
    expect(new Set(phrases).size).toBe(phrases.length)
    expect(phrases.every((phrase) => /^"[^"]{3}"$/u.test(phrase))).toBe(true)
  })

  it('leaves a normal query alone', () => {
    // Three-plus characters per CJK term: shorter runs are skipped by the trigram branch on purpose
    // (an n-gram table cannot match them — see `store/lexical.ts#substringTerms` for the leg-side
    // fallback, which is deliberately NOT this builder's business).
    expect(buildFtsQuery('老王头 喜欢她', 'trigram')).toBe('"老王头" OR "喜欢她"')
  })
})

describe('likeSubstring (the short-query fallback predicate)', () => {
  it('builds one escaped LIKE per term and a same-order count expression', () => {
    // A 2-char CJK term cannot be expressed by the trigram index at all (measured: every term in
    // `facts_fts` is 3 characters), so the leg falls back to the substring predicate the FTS5 trigram
    // TABLE still exposes. The terms are the CALLER's text, so `%`/`_`/`\` must be escaped or a
    // literal query silently becomes a wildcard.
    const built = likeSubstring('fa.content', ['李娜', '100%', 'a_b', 'c\\d'])
    expect(built.params).toEqual(['%李娜%', '%100\\%%', '%a\\_b%', '%c\\\\d%'])
    expect(built.any).toBe(
      "fa.content LIKE ? ESCAPE '\\' OR fa.content LIKE ? ESCAPE '\\' OR fa.content LIKE ? ESCAPE '\\' OR fa.content LIKE ? ESCAPE '\\'",
    )
    // `count` is the relevance score (`ranks` the number of terms a row contains) — parenthesised, or
    // `a LIKE ? + b LIKE ?` would bind the `+` to the pattern.
    expect(built.count.split(' + ')).toHaveLength(4)
    expect(built.count.startsWith("(fa.content LIKE ? ESCAPE '\\')")).toBe(true)
  })

  it('drops empty terms so a caller never gets a match-everything pattern', () => {
    const built = likeSubstring('dc.text', ['', '网关'])
    expect(built.params).toEqual(['%网关%'])
    expect(built.any.split(' OR ')).toHaveLength(1)
  })

  it('the predicate actually matches through SQLite with escaping intact', () => {
    const db = dbWith('t', "CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')")
    try {
      db.prepare('INSERT INTO t(text) VALUES (?)').run('李娜负责支付网关')
      db.prepare('INSERT INTO t(text) VALUES (?)').run('100% 的进度')
      const { any, params } = likeSubstring('text', ['李娜'])
      expect(db.prepare(`SELECT rowid FROM t WHERE ${any}`).all(...params)).toHaveLength(1)
      const pct = likeSubstring('text', ['100%'])
      expect(db.prepare(`SELECT rowid FROM t WHERE ${pct.any}`).all(...pct.params)).toHaveLength(1)
      // The escaped `%` is a literal: a pattern that would match everything does not.
      const lit = likeSubstring('text', ['999%'])
      expect(db.prepare(`SELECT rowid FROM t WHERE ${lit.any}`).all(...lit.params)).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
