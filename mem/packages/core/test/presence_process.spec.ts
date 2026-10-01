import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { openMemoryDb, type Db } from '../src/db/conn.js'
import { readClock } from '../src/lifecycle/presence.js'

/**
 * TRUST_MODEL.md §2.1/§9/§12: "两个 runtime 指向同一 DB 同时启动 → 时钟只推进一次".
 *
 * This one uses two real OS PROCESSES, not two connections in a single thread: only
 * that proves the `db.transaction(...).immediate()` read-modify-write actually
 * serializes across processes. Each child re-establishes a 90-day gap and then calls
 * `advancePresence`, so a missing transaction shows up as a LOST UPDATE — the stored
 * clock would drift below the sum of the days every process believes it counted.
 *
 * The children run through vite-node (the runner vitest itself uses) so they import
 * the real TypeScript sources: no build step, no duplicated logic.
 */
const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const childScript = join(here, 'fixtures', 'presence_child.ts')
/** vite-node ships with vitest — resolve it through vitest's own dependency tree. */
const viteNodeCli = join(
  dirname(require.resolve('vite-node/package.json', { paths: [require.resolve('vitest/package.json')] })),
  'dist',
  'cli.mjs',
)

interface ChildResult {
  counted: number[]
  clocks: number[]
}

function runChild(dbPath: string, barrierDir: string, rounds: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteNodeCli, childScript], {
      env: {
        ...process.env,
        AVANTF_CHILD_DB: dbPath,
        AVANTF_CHILD_BARRIER: barrierDir,
        AVANTF_CHILD_ROUNDS: String(rounds),
        AVANTF_CHILD_PEERS: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += String(d) })
    child.stderr.on('data', (d: Buffer) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`presence child exited ${String(code)}\n--- stderr ---\n${err.slice(-2000)}\n--- stdout ---\n${out.slice(-2000)}`))
      }
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
      if (!line) return reject(new Error(`presence child printed no result: ${out.slice(-500)}`))
      resolve(JSON.parse(line) as ChildResult)
    })
  })
}

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-proc-'))
  db = openMemoryDb(join(dir, 'memory.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('multi-process presence clock (TRUST_MODEL.md §2.1)', () => {
  it('two OS processes racing on one DB keep the clock equal to the sum of counted days', async () => {
    const dbPath = join(dir, 'memory.db')
    // Shared rendezvous dir: the children wait for each other there, so the race is
    // real mission overlapping in time rather than two sequential child startups.
    const barrierDir = join(dir, 'barrier')
    mkdirSync(barrierDir)
    const rounds = 1500
    const [a, b] = await Promise.all([runChild(dbPath, barrierDir, rounds), runChild(dbPath, barrierDir, rounds)])

    const counted = [...a.counted, ...b.counted]
    const total = counted.reduce((x, y) => x + y, 0)
    // Every presence counts 0..1 active days (D2) …
    expect(counted.every((c) => c >= 0 && c <= 1)).toBe(true)
    expect(total).toBeGreaterThan(0)
    // … and the persisted clock is EXACTLY their sum. A lost update (two processes
    // reading the same clock and each writing its own +1) would leave the clock smaller.
    expect(readClock(db)).toBeCloseTo(total, 6)
    // The clock is monotonic: each process's own observation sequence never goes back.
    for (const clocks of [a.clocks, b.clocks]) {
      for (let i = 1; i < clocks.length; i++) expect(clocks[i]!).toBeGreaterThanOrEqual(clocks[i - 1]!)
    }
  }, 60000)
})
