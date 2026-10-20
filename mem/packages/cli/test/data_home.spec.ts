/**
 * `--data-home` (layer ⑤) and the CLI's explicit `deferWarm`.
 *
 * Two defects are pinned here, each by its own assertion:
 *
 *   1. **The documented flag did not exist.** Switching the data root meant setting `AVANTF_HOME`,
 *      which is the FAMILY root: it moves the data home AND `models`/`tools`. Two processes that
 *      then resolve different model caches can end up with different representation fingerprints, and
 *      the vectors one of them wrote are declared "an OLDER embedding space" by the other. The flag
 *      gives layer ⑤ without touching the family root, and this spec proves the two roots separate.
 *   2. **Read-only commands loaded the model.** `buildRuntime` without `managedRoots` used to let the
 *      adapters warm in their constructor, so `stats` / `export` paid a load on every machine and a
 *      full model download on a fresh one. The CLI now passes `deferWarm: true` and warms only from
 *      `needsModels`; the end-to-end tests below assert the absence/presence of the warm log lines.
 *
 * The entry cannot be imported here (`main()` runs at module scope, and importing another package's
 * source is outside this tsconfig's `rootDir`), so the wiring assertions read it as text — the same
 * precedent as `core/test/cli_warmup.spec.ts`, which owns the warmup TABLE's classification.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntime } from '@avantf/mem'
import { familyModelsDir } from '@avantf/mem-contract'
import type { AvantfLogger } from '@avantf/mem-contract'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'lib', 'index.js')
const CLI_SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** A block of the entry's source, from one marker to the next. */
function slice(from: string, to: string): string {
  const start = CLI_SOURCE.indexOf(from)
  const end = CLI_SOURCE.indexOf(to, start + from.length)
  expect(start, `the entry must contain ${from}`).toBeGreaterThanOrEqual(0)
  expect(end, `the entry must contain ${to}`).toBeGreaterThan(start)
  return CLI_SOURCE.slice(start, end)
}

/** A throwaway directory removed by `finally` — never the real `~/.avantf`. */
function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Run the built CLI and capture BOTH streams (logs are on stderr by design). */
function runCli(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Set process env for one scoped call, restoring every touched key afterwards. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A logger that records every line the runtime (and the retrieval core) emit. */
function captureLogger(): { logger: AvantfLogger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (message: string) => lines.push(`INFO ${message}`),
      warn: (message: string) => lines.push(`WARN ${message}`),
      error: (message: string) => lines.push(`ERROR ${message}`),
    },
  }
}

describe('CLI --data-home (layer ⑤)', () => {
  it('passes the scanned flag and deferWarm: true into buildRuntime', () => {
    // The wiring, not the implementation: the flag is pulled out of the WHOLE argv before the command
    // is read, and the runtime is told to own the warm schedule. Either half missing re-opens one of
    // the two defects: no flag means "use AVANTF_HOME and move the model cache too"; no deferWarm
    // means the adapter warms in its constructor before `needsModels` can say no.
    const main = slice('async function main(', 'function readStdin(')
    expect(main).toContain('takeDataHome(process.argv.slice(2))')
    expect(main).toMatch(/buildRuntime\(\{[^}]*deferWarm: true/u)
  })

  it('is layer ⑤: it wins over AVANTF_HOME and leaves the model cache at the FAMILY root', () => {
    const family = tmpDir('avf-family-')
    const data = tmpDir('avf-data-')
    try {
      // No AVANTF_MEM_MODEL_CACHE: the cache must be the family root itself, or "did not move" is
      // untestable. (`vitest.config.ts` sets that env var for the whole suite; scoped restore below.)
      withEnv({ AVANTF_HOME: family, AVANTF_MEM_MODEL_CACHE: undefined }, () => {
        const rt = buildRuntime({ dataHome: data, deferWarm: true })
        try {
          // The data root followed the explicit argument, NOT the env var.
          expect(rt.config.home).toBe(data)
          expect(existsSync(join(data, 'memory'))).toBe(true)
          expect(existsSync(join(family, 'memory'))).toBe(false)
          // The model root stayed at the family root — only the data root moved.
          expect(rt.config.common.semantic.cache_dir).toBe(familyModelsDir())
          expect(rt.config.common.semantic.cache_dir).not.toBe(rt.config.home)
        } finally {
          rt.shutdown()
        }
      })
    } finally {
      rmSync(family, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('deferWarm is exactly what keeps the constructor from warming (negative control included)', () => {
    const data = tmpDir('avf-nowarm-')
    try {
      // Negative control: without deferWarm the adapter warms in the constructor and says so. Without
      // this half, "no loading line" below could pass for the wrong reason (a log level, a missing
      // dependency) instead of because the warm was actually deferred.
      const eager = captureLogger()
      const warmed = buildRuntime({ dataHome: data, logger: eager.logger })
      warmed.shutdown()
      expect(eager.lines.join('\n')).toContain('semantic: loading embedding model')

      const deferred = captureLogger()
      const quiet = buildRuntime({ dataHome: data, deferWarm: true, logger: deferred.logger })
      quiet.shutdown()
      expect(deferred.lines.join('\n')).not.toContain('semantic: loading embedding model')
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
})

describe('CLI --data-home end to end', () => {
  it('lands data in --data-home (both spellings) while AVANTF_HOME stays the family root', () => {
    const family = tmpDir('avf-family-')
    const data = tmpDir('avf-data-')
    try {
      const env = { AVANTF_HOME: family }
      // Space form. The flag is stripped before dispatch, so it must not become part of the fact.
      const add = runCli(['add', '王五负责网关', '--data-home', data], env)
      expect(add.status, add.stderr).toBe(0)
      expect(existsSync(join(data, 'memory', 'memory.db'))).toBe(true)
      expect(existsSync(join(family, 'memory'))).toBe(false)

      // `=` form, and a read-only command: it must not warm the model.
      const stats = runCli(['stats', `--data-home=${data}`], env)
      expect(stats.status, stats.stderr).toBe(0)
      expect(stats.stderr).not.toContain('model bootstrap: warm start')
      expect(stats.stderr).not.toContain('semantic: loading embedding model')

      const list = runCli(['list', `--data-home=${data}`], env)
      expect(list.status, list.stderr).toBe(0)
      const facts = (JSON.parse(list.stdout) as { facts: { content: string }[] }).facts
      expect(facts.map((fact) => fact.content)).toContain('王五负责网关')
    } finally {
      rmSync(family, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('a command that encodes still warms explicitly', () => {
    const family = tmpDir('avf-family-')
    const data = tmpDir('avf-data-')
    try {
      const add = runCli(['add', '另一条事实', '--data-home', data], { AVANTF_HOME: family })
      expect(add.status, add.stderr).toBe(0)
      // deferWarm moved the warm, it did not remove it: `needsModels` still warms for `add`.
      expect(add.stderr).toContain('model bootstrap: warm start')
    } finally {
      rmSync(family, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('refuses a missing or blank value instead of silently using the default', () => {
    const family = tmpDir('avf-family-')
    try {
      const cases: string[][] = [
        ['--data-home'],
        ['--data-home', '--limit', '5'],
        ['--data-home='],
        ['stats', '--data-home', ''],
      ]
      for (const args of cases) {
        const out = runCli(args, { AVANTF_HOME: family })
        expect(out.status, args.join(' ')).not.toBe(0)
        expect(out.stderr, args.join(' ')).toContain('--data-home')
      }
      // Nothing was created under the family root by any of the refused calls.
      expect(existsSync(join(family, 'memory'))).toBe(false)
    } finally {
      rmSync(family, { recursive: true, force: true })
    }
  })
})
