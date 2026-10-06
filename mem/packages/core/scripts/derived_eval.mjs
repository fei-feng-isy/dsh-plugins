#!/usr/bin/env node
/**
 * P-02 regression net — the derived-query runner.
 *
 *   node scripts/derived_eval.mjs --mode stub              # PR: deterministic, no model, ~instant
 *   node scripts/derived_eval.mjs --mode real              # nightly: real embedder, downloads a model
 *
 * The two modes share the fixtures from `derive.ts`; only the retriever differs. The stub arm is
 * what a PR can afford, and it is the arm that proves the FIXTURE (planted carrier outranks the
 * gold; removing it restores the gold) rather than the product. The real arm reports what the
 * actual store does with those same queries.
 *
 * Output goes to a TEMP directory by default — the derived corpus is large and machine-generated,
 * so it must never be committed. `--out` overrides the path.
 *
 * Requires a build first (`pnpm -C mem build`): this script imports the emitted `lib/`, exactly like
 * the bench harness does.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (rel) => new URL(`../lib/${rel}`, import.meta.url).href

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const mode = arg('mode', 'stub')
const seed = Number(arg('seed', '20261006'))
const corpusSize = Number(arg('corpus', '60'))
if (!['stub', 'real'].includes(mode)) {
  console.error(`unknown --mode ${mode} (expected stub|real)`)
  process.exit(2)
}
const out = arg('out', join(tmpdir(), 'avantf-derived-eval', `derived-${mode}.json`))

const { REAL_LENGTH_PROFILE, analyzeCorpus, deriveCases, synthesizeCorpus } = await import(lib('eval/derive.js'))
const { runDerivedSuiteStub, runDerivedCaseReal } = await import(lib('eval/derived_runner.js'))

const corpus = synthesizeCorpus(corpusSize, seed)
const cases = deriveCases(corpus, { seed })
const analysis = analyzeCorpus(corpus)

let report
if (mode === 'stub') {
  const suite = runDerivedSuiteStub(cases)
  report = {
    mode,
    generated_at: new Date().toISOString(),
    seed,
    corpus: { n: corpus.length, analysis, real_profile: REAL_LENGTH_PROFILE },
    arm: suite,
    pass: suite.all_collision_self_checks_pass && !suite.any_time_word_query && suite.all_irrelevant_empty,
  }
} else {
  // One runtime PER CASE, so a case's corpus cannot contaminate another's ranking.
  const { buildRuntime } = await import(lib('runtime.js'))
  const arms = []
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-derived-real-'))
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      arms.push(await runDerivedCaseReal(rt, c))
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const graded = arms.map((a) => ({
    id: a.id,
    gold_ranks: a.queries.map((q) => q.gold_rank),
    carrier_ranks: a.queries.map((q) => q.carrier_rank),
    must_include_ok: a.queries.map((q) => q.must_include_ok),
    must_exclude_ok: a.queries.map((q) => q.must_exclude_ok),
  }))
  report = {
    mode,
    generated_at: new Date().toISOString(),
    seed,
    corpus: { n: corpus.length, analysis, real_profile: REAL_LENGTH_PROFILE },
    cases: graded,
    // The real arm is REPORTING, not gating: the fixture's guarantees are the stub arm's job, and a
    // nightly run that turned a ranking observation into a red build would be re-frozen on every
    // model update instead of reviewed.
    note: 'real-model arm reports rankings; the collision self-check is the stub arm',
  }
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(`derived eval (${mode}) → ${out}`)
if (mode === 'stub') {
  console.log(`collision self-checks: ${report.pass ? 'PASS' : 'FAIL'}`)
  if (!report.pass) process.exit(1)
}
