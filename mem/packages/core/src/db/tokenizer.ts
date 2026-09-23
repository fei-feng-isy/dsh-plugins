import { retrievalLogger } from '@avantf/mem-core'
import type { Db } from './port.js'
import { openSqlite } from './sqlite.js'

/** FTS5 tokenizer actually used to build the `*_fts` tables. */
export type FtsTokenizer = 'trigram' | 'unicode61'

let trigramOk: boolean | null = null
let warned = false

/**
 * Probe the SQLite build for a WORKING FTS5 `trigram` tokenizer: not just "does
 * the tokenizer exist" but "does it actually n-gram CJK" (`unicode61` would treat
 * a whole Chinese phrase as one token, silently breaking full-text search).
 *
 * Runs against a throwaway in-memory database through the same port as every store, so it
 * can never pollute a real store, and is cached per process.
 */
function probeTrigram(): boolean {
  let db: Db | null = null
  try {
    db = openSqlite(':memory:')
    db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize='trigram')")
    db.prepare('INSERT INTO probe_fts(content) VALUES (?)').run('验证中文分词测试')
    const hit = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM probe_fts WHERE probe_fts MATCH ?').get('中文分词')
    const miss = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM probe_fts WHERE probe_fts MATCH ?').get('不存在的短语')
    return (hit?.n ?? 0) >= 1 && miss?.n === 0
  } catch {
    return false
  } finally {
    db?.close()
  }
}

/** Whether this SQLite build supports the CJK-aware FTS5 `trigram` tokenizer. */
export function trigramAvailable(): boolean {
  if (trigramOk === null) trigramOk = probeTrigram()
  return trigramOk
}

/**
 * Choose the tokenizer for newly created FTS tables — DESIGN §16 mitigation.
 *
 * A build without `trigram` must not make the store unopenable: fall back to
 * `unicode61` (CJK recall degrades to exact/whole-token matching) and say so once.
 * This has to run BEFORE the schema DDL, because `CREATE VIRTUAL TABLE … TOKENIZE
 * trigram` on such a build throws.
 */
export function resolveFtsTokenizer(): FtsTokenizer {
  if (trigramAvailable()) return 'trigram'
  if (!warned) {
    warned = true
    retrievalLogger().warn(
      'FTS5 trigram tokenizer unavailable — creating FTS tables with unicode61; '
      + 'CJK full-text search will be limited (DESIGN §16 mitigation)',
    )
  }
  return 'unicode61'
}

// ─── MATCH-expression building (shared by BOTH stores) ─────────────────────

/**
 * The tokenizer an EXISTING FTS table was actually built with, or `null` if there is no such table.
 *
 * Read from `sqlite_master` — not from a stored flag, and not from this build's probe. `CREATE
 * VIRTUAL TABLE IF NOT EXISTS` never rebuilds an existing table, so what the index contains was
 * decided by the DDL that ran when the database was first created: possibly years ago, possibly on
 * another machine, possibly against a SQLite build with different FTS5 support. Querying it with
 * the OTHER convention is silent zero recall — a trigram table cannot match a whole-token phrase and
 * a unicode61 table cannot match a 3-gram, and neither raises an error. The store therefore asks the
 * database which tokenizer it has, and builds MATCH expressions for THAT one.
 */
export function detectFtsTokenizer(db: Db, table: string): FtsTokenizer | null {
  const row = db.prepare<{ sql: string | null }>('SELECT sql FROM sqlite_master WHERE name = ?').get(table)
  const sql = row?.sql
  if (typeof sql !== 'string') return null
  const tokenize = /tokenize\s*=\s*'([^']*)'/i.exec(sql) ?? /tokenize\s*=\s*"([^"]*)"/i.exec(sql)
  // No `tokenize=` in the DDL means FTS5's own default, which is unicode61.
  if (tokenize === null) return 'unicode61'
  return tokenize[1].trim().toLowerCase().startsWith('trigram') ? 'trigram' : 'unicode61'
}

/** One warning per (store, tokenizer) pair: this runs on every open, and repeating it is noise. */
const driftWarned = new Set<string>()

/**
 * Say something when a database's FTS table is WEAKER than what this SQLite build could give it.
 *
 * Only that direction is worth a line. The reverse (a trigram table opened by a build without
 * trigram support) loses nothing: the queries are built for the table that exists, so recall is
 * exactly what it was. But a unicode61 table opened by a trigram-capable build means CJK full-text
 * recall is limited to whole-token matches — a real, invisible degradation that an operator can fix,
 * so it is reported once with the remedy named.
 *
 * @param label  store label for the message
 * @param table  the FTS table whose DDL was read
 * @param detected what {@link detectFtsTokenizer} found (`null` = the table does not exist yet)
 * @param remedy how to rebuild that table, or `null` when no operator-facing command does
 */
export function reportFtsTokenizerDrift(
  label: string,
  table: string,
  detected: FtsTokenizer | null,
  remedy: string | null,
): void {
  if (detected === null || detected !== 'unicode61') return
  if (resolveFtsTokenizer() !== 'trigram') return
  const key = `${label}:${table}`
  if (driftWarned.has(key)) return
  driftWarned.add(key)
  retrievalLogger().warn(
    `${label}: ${table} 是用 unicode61 建的，而当前 SQLite 构建支持 trigram —— 查询已按表实际的 `
    + 'tokenizer 构造（不会静默零召回），但中文全文匹配只能整词命中，召回受限。'
    + (remedy === null ? '重建该 FTS 表即可升级。' : `运行 ${remedy} 重建即可升级。`),
  )
}

const FTS_SPLIT = /[\s"*+()\-:^]+/
const CJK_RE = /[㐀-䶿一-鿿぀-ゟ゠-ヿ가-힯]/

/**
 * The most OR phrases one query may expand to.
 *
 * 64 is far past any query a person types (a 64-character CJK run), and it is the ceiling that keeps a
 * pathological input from turning `MATCH` into minutes of synchronous work inside the host process.
 */
export const MAX_FTS_PHRASES = 64

/**
 * Build an FTS5 MATCH expression for the tokenizer the tables were created with.
 *
 * - `trigram`: CJK tokens become OR-joined 3-grams (a phrase needs ≥3 chars);
 *   latin tokens are quoted whole (≥3 chars — the trigram minimum).
 * - `unicode61` (fallback build): whole-token phrases; CJK is NOT n-grammed
 *   (trigram phrases can never match a unicode61 table, so emitting them there
 *   would mean silent zero recall — the old duplicated builders did exactly that).
 *
 * One implementation for memory + knowledge (the two copies had already drifted
 * once when the tokenizer fallback landed).
 */
export function buildFtsQuery(query: string, tokenizer: FtsTokenizer = resolveFtsTokenizer()): string | null {
  const tokens = query.trim().split(FTS_SPLIT).filter(Boolean)
  const parts: string[] = []
  for (const tok of tokens) {
    const clean = tok.replace(/"/g, '')
    if (!clean) continue
    if (tokenizer === 'trigram') {
      if (CJK_RE.test(clean)) {
        if (clean.length < 3) continue
        for (let i = 0; i + 3 <= clean.length; i++) parts.push(`"${clean.slice(i, i + 3)}"`)
      } else if (clean.length >= 3) {
        parts.push(`"${clean}"`)
      }
    } else if (clean.length >= 2) {
      parts.push(`"${clean}"`)
    }
  }
  if (!parts.length) return null
  // Dedupe first: a long CJK run repeats its trigrams, and `"abc" OR "abc"` is exactly `"abc"` — the
  // duplicates cost `MATCH` time and buy nothing. Then cap: the contract already refuses a query past
  // `MAX_QUERY_CHARS`, so this is the second line of defence for a direct caller of the engine, and it
  // bounds the work at a number the tokenizer owns rather than at one the caller chose.
  const unique = [...new Set(parts)]
  return unique.slice(0, MAX_FTS_PHRASES).join(' OR ')
}
