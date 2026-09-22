/**
 * `avantf_stats` — the key/value side table (currently the active-day clock and the last
 * presence timestamp).
 *
 * Lives in `db/dao/` like every other aggregate: the SQL belongs to the DAO, while what the
 * clock MEANS and when it advances stays in `lifecycle/presence.ts`.
 */
import type { Db } from '../port.js'

export class StatsDao {
  constructor(private readonly db: Db) {}

  read(key: string): string | null {
    const row = this.db.prepare<{ value: string }>('SELECT value FROM avantf_stats WHERE key = ?').get(key)
    return row === undefined ? null : row.value
  }

  write(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO avantf_stats (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(key, value)
  }
}
