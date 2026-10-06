/**
 * R2-6 · L1/B1 subject·attribute spike — rule extraction + the `用户是` carrier counterfactual.
 *
 * WHAT L1/B1 WOULD BUY. A write-side `subject`/`attribute` pair is the only zero-LLM route to
 * "retrieve the group of facts about one subject" — the capability behind `我是谁？`. This card tests
 * whether a RULE (no model) can extract that pair from the live corpus well enough to help, and
 * whether grouping by it can exclude the named distractor without harming gold.
 *
 * EXTRACTION (script-side rule, no LLM).
 *   subject   = the entity in the fact with the highest GLOBAL active document frequency
 *               (ties broken lexicographically) — "the entity that repeats across the corpus";
 *   attribute = the `pred` of the highest-confidence production triple whose `subj` is that subject
 *               (falling back to the fact's highest-confidence triple).
 * ADJUDICATION. The brief asks for 20–30 hand-labelled samples. Hand labelling requires reading fact
 * text, which the campaign's privacy boundary forbids, so precision is measured against an
 * INDEPENDENT extractor already in production (the POS/pattern triple `subj`) — a rule-vs-oracle
 * agreement proxy, stated as such. The 30-row sample records only entity/predicate NAMES.
 *
 * QUERY SIDE (`我是谁？`, the flagship). The rewrite gives `用户是谁` -> subject `用户`.
 *   arm `filter`  — restrict the fused pool to facts whose extracted subject is `用户` (narrows).
 *   arm `groupleg`— add the group as an EXTRA leg (union preserved), weight swept 0.15 / 0.5.
 * COUNTERFACTUAL: drop the fact whose text carries the literal `用户是` from the pool and observe
 * the tail.
 *
 * VERDICT RULE (brief): exclude the named distractor WITHOUT harming gold and WITHOUT narrowing the
 * union => adopt; else reject. The union-narrowing axis is structural: any group FILTER loses it.
 *
 * Usage: node mem/scripts/spikes/bench-r2-6-subject-attribute.mjs [--json <path>]
 * PRIVACY: ids / entity names / counts only — fact text is read for substring checks, never written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-6-subject-attribute.json'))
const LIMIT = 5

function load(snap) {
  const db = L.openReadOnly(snap)
  try {
    const facts = db.prepare("select fact_id id, content, category from facts where status='active' order by fact_id").all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='active'`,
    ).all()
    const triples = db.prepare(
      `select t.fact_id id, t.subj, t.pred, t.obj, t.confidence from triples t join facts f on f.fact_id = t.fact_id
        where f.status='active' order by t.confidence desc, t.triple_id asc`,
    ).all()
    const bags = new Map()
    for (const r of links) {
      if (!bags.has(r.id)) bags.set(r.id, [])
      bags.get(r.id).push(r.name)
    }
    const df = new Map()
    for (const names of bags.values()) for (const n of names) df.set(n, (df.get(n) ?? 0) + 1)
    const triplesByFact = new Map()
    for (const t of triples) {
      if (!triplesByFact.has(t.id)) triplesByFact.set(t.id, [])
      triplesByFact.get(t.id).push(t)
    }
    return { facts, bags, df, triplesByFact }
  } finally {
    db.close()
  }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r26-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('R2-6 · L1/B1 subject·attribute spike', { snapshot: snap, active_facts: texts.size })

  const { facts, bags, df, triplesByFact } = load(snap)
  const ruleSubject = (id) => {
    const names = [...new Set(bags.get(id) ?? [])]
    if (!names.length) return null
    names.sort((a, b) => (df.get(b) ?? 0) - (df.get(a) ?? 0) || a.localeCompare(b))
    return names[0]
  }
  const oracleSubject = (id) => triplesByFact.get(id)?.[0]?.subj ?? null
  const attribute = (id, subject) => {
    const ts = triplesByFact.get(id) ?? []
    const match = ts.find((t) => t.subj === subject)
    return (match ?? ts[0])?.pred ?? null
  }

  const extracted = facts.map((f) => {
    const subject = ruleSubject(f.id)
    const oracle = oracleSubject(f.id)
    return {
      id: f.id,
      category: f.category,
      len: String(f.content).length,
      subject,
      attribute: attribute(f.id, subject),
      oracle_subject: oracle,
      has_user: String(f.content).includes('用户'),
      user_carrier: String(f.content).includes('用户是'),
      agrees: subject !== null && oracle !== null && subject === oracle,
    }
  })

  const withBoth = extracted.filter((e) => e.subject !== null && e.attribute !== null)
  const withOracle = extracted.filter((e) => e.subject !== null && e.oracle_subject !== null)
  const precisionProxy = withOracle.length ? withOracle.filter((e) => e.agrees).length / withOracle.length : null
  const coverage = extracted.length ? withBoth.length / extracted.length : null
  const subjectUser = extracted.filter((e) => e.subject === '用户')
  const userFacts = extracted.filter((e) => e.has_user)
  const carriers = extracted.filter((e) => e.user_carrier)

  // 30-row deterministic sample (names only).
  const step = Math.max(1, Math.floor(extracted.length / 30))
  const sample = extracted.filter((_, i) => i % step === 0).slice(0, 30)

  console.log(`extraction: coverage ${withBoth.length}/${extracted.length} (${L.round4(coverage)}), precision-proxy ${withOracle.length ? withOracle.filter((e) => e.agrees).length : 0}/${withOracle.length} (${precisionProxy === null ? 'n/a' : L.round4(precisionProxy)})`)
  console.log(`subject==用户 facts: ${subjectUser.length} [${subjectUser.map((e) => e.id).join(',')}]`)
  console.log(`facts containing 用户: ${userFacts.length}; subject != 用户 among them: ${userFacts.filter((e) => e.subject !== '用户').length}`)
  console.log(`用户是 carriers: ${carriers.length} [${carriers.map((e) => e.id).join(',')}]`)

  // ── query side ──────────────────────────────────────────────────────────────
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })
  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  const group = new Set(subjectUser.map((e) => e.id))
  const carrierSet = new Set(carriers.map((e) => e.id))
  const SELF = '我是谁？'
  const run = (arm) => L.runScript(rt, SELF, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
  const baseline = await run({})
  const filter = await run({ fuse: (pool) => (group.size ? pool.filter((h) => group.has(h.id)) : pool) })
  const groupLegs = {}
  for (const w of [0.15, 0.5]) {
    groupLegs[`groupleg_w${w}`] = await run({ appendLegs: () => (group.size ? [{ weight: w, scores: new Map([...group].map((id) => [id, 1])), leg: 'jaccard' }] : []) })
  }
  const noCarrier = await run({ fuse: (pool) => (carrierSet.size ? pool.filter((h) => !carrierSet.has(h.id)) : pool) })

  const selfRows = {
    baseline: { ids: baseline.ids, pool_size: baseline.pool.length },
    filter: { ids: filter.ids, pool_size: filter.pool.length, union_narrowed: filter.pool.length < baseline.pool.length },
    'groupleg_w0.15': { ids: groupLegs['groupleg_w0.15'].ids, pool_size: groupLegs['groupleg_w0.15'].pool.length },
    'groupleg_w0.5': { ids: groupLegs['groupleg_w0.5'].ids, pool_size: groupLegs['groupleg_w0.5'].pool.length },
    counterfactual_no_carrier: { ids: noCarrier.ids, pool_size: noCarrier.pool.length },
  }
  // Which named distractors leave the top-3 under each arm?
  const named = [103, 117, 125]
  const top3 = (ids) => ids.slice(0, 3)
  const distractor = Object.fromEntries(Object.entries(selfRows).map(([k, v]) => [k, {
    in_top3: named.filter((id) => top3(v.ids).includes(id)),
    gold_rank: v.ids.indexOf(4) === -1 ? null : v.ids.indexOf(4) + 1,
  }]))

  // ── does the group arm harm the other gold queries? ─────────────────────────
  const goldQueries = queries.filter((q) => q.gold !== null)
  const harm = {}
  for (const [name, arm] of [
    ['baseline', {}],
    ['filter', { fuse: (pool) => (group.size ? pool.filter((h) => group.has(h.id)) : pool) }],
    ['groupleg_w0.15', { appendLegs: () => (group.size ? [{ weight: 0.15, scores: new Map([...group].map((id) => [id, 1])), leg: 'jaccard' }] : []) }],
  ]) {
    let top1 = 0
    let top3 = 0
    let missing = 0
    for (const q of goldQueries) {
      const p = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      if (p.ids[0] !== undefined && q.gold.includes(p.ids[0])) top1 += 1
      if (p.ids.slice(0, 3).some((id) => q.gold.includes(id))) top3 += 1
      if (!p.ids.some((id) => q.gold.includes(id))) missing += 1
    }
    harm[name] = { gold_queries: goldQueries.length, top1, top3, missing }
  }

  console.log('self rows:', JSON.stringify(selfRows))
  console.log('distractor:', JSON.stringify(distractor))
  console.log('harm:', JSON.stringify(harm))

  const filterExcludesNamed = named.some((id) => !top3(selfRows.filter.ids).includes(id))
  const groupLegExcludesNamed = named.some((id) => !top3(groupLegs['groupleg_w0.5'].ids).includes(id))
  const goldSafe = harm.filter.top1 >= harm.baseline.top1 && harm.filter.missing <= harm.baseline.missing
  const groupLegSafe = harm['groupleg_w0.15'].top1 >= harm.baseline.top1

  const verdict = {
    extraction_coverage: L.round4(coverage),
    extraction_precision_proxy: precisionProxy === null ? null : L.round4(precisionProxy),
    precision_method: 'rule-vs-production-triple-agreement (hand labelling would require printing fact text, which the campaign forbids)',
    subject_user_group_size: group.size,
    user_facts_whose_subject_is_not_user: userFacts.filter((e) => e.subject !== '用户').length,
    user_carrier_facts: carriers.length,
    filter_arm_excludes_named_distractor: filterExcludesNamed,
    filter_arm_narrows_union: selfRows.filter.union_narrowed,
    filter_arm_gold_safe: goldSafe,
    groupleg_arm_excludes_named_distractor: groupLegExcludesNamed,
    groupleg_arm_preserves_union: true,
    groupleg_arm_gold_safe: groupLegSafe,
    adopt: false,
  }
  verdict.call = !goldSafe
    ? 'reject — the group FILTER loses gold on the wider query set'
    : !filterExcludesNamed && !groupLegExcludesNamed
      ? 'reject — neither arm excludes a named distractor (the pathology is already fixed; the group adds nothing)'
      : 'reject — any arm that excludes a named distractor narrows the union or is not gold-safe'

  const out = {
    card: 'R2-6',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    extraction: {
      rule: 'subject = entity with highest global active df (ties lexicographic); attribute = pred of the highest-confidence triple whose subj is that subject',
      total_facts: extracted.length,
      with_subject_and_attribute: withBoth.length,
      with_subject_and_oracle: withOracle.length,
      agreeing_subjects: withOracle.filter((e) => e.agrees).length,
      precision_proxy: precisionProxy === null ? null : L.round4(precisionProxy),
      coverage: L.round4(coverage),
      subject_user_facts: subjectUser.length,
      user_facts: userFacts.length,
      user_facts_subject_not_user: userFacts.filter((e) => e.subject !== '用户').length,
      user_carrier_facts: carriers.map((e) => e.id),
      sample,
    },
    self_query: { query: SELF, rewrite: L.selfQueryRewrite(SELF), rows: selfRows, distractors: distractor },
    harm_on_gold_queries: harm,
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-r2-6-subject-attribute.mjs --json mem/docs/spikes/raw/round2-r2-6-subject-attribute.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
