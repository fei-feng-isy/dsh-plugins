/**
 * Round-6 · S2 — the FIVE relation actions' zero baseline.
 *
 * This is the round's core: `chain` / `probe` / `reason` / `related` / `contradict` have never
 * been measured against real-corpus questions. For each action this card builds >=10 questions
 * FROM the live corpus (never synthetic), runs the PRODUCTION action (default parameters) and
 * records:
 *
 *   - answered            : did the action return anything at all;
 *   - gold_hit            : is the question's gold in the returned set / top-3;
 *   - precision_top3      : share of the top-3 that is actually about the question's subject;
 *   - narrowed            : is the action's id set a STRICT subset of the union of the three
 *                           production retrieval legs for the same rendered question? (A filter-
 *                           shaped action can only narrow the union; an extra-carrier action
 *                           reaches facts the union does not.)
 *   - identity            : production dispatch `rt.recall` == the store method it delegates to.
 *
 * TWO HONESTY NOTES that must travel with the numbers:
 *   1. `chain`'s gold is derived from the SAME triple the action walks, so "gold hit" is a
 *      construction, not a capability. The real reading is `mid_is_entity`: whether the first hop
 *      lands on an entity name or on a text fragment. Same structure for `reason` (its join IS the
 *      gold predicate) — its real reading is the pairs that do NOT co-occur.
 *   2. `contradict` on the real corpus is an empty list (the log has 0 rows). Capability is
 *      therefore measured on KNOWN injected pairs in a temp snapshot copy: 6 true pairs (a
 *      sentence vs its explicit negation) and 6 false pairs. The store is never written.
 *
 * A <=24-item manual sample goes to `/tmp/dsh-r6/s2-sample.json`; `/tmp/dsh-r6/s2-judgment.json`
 * (if present) folds its verdicts in.
 *
 * OUTPUT: `mem/docs/spikes/raw/round6-s2-actions.json`.
 * Usage: node mem/scripts/spikes/bench-r6-2-actions.mjs [--json <path>] [--per-action N]
 */
import { join } from 'node:path'
import * as B from './bench-r6-lib.mjs'

const outPath = B.arg('json', join(B.REPO, 'docs/spikes/raw/round6-s2-actions.json'))
const perAction = Number(B.arg('per-action', 12))

const ids = (hits) => (hits ?? []).map((h) => h.ref_id ?? h.id)

async function main() {
  B.banner('round6 · S2 relation actions')
  B.ensureTmp()
  const work = B.L.mkdtempSync(join(B.L.tmpdir(), 'avantf-r6-s2-'))
  const snap = join(work, 'memory.db')
  B.snapshotDb(B.pinSource(), snap)
  const metaDb = B.openReadOnly(snap)
  const active = metaDb.prepare("select fact_id id from facts where status = 'active' order by fact_id").all().map((r) => r.id)
  const activeSet = new Set(active)
  const triples = B.activeTriples(metaDb).filter((t) => activeSet.has(t.fact_id))
  const bags = B.entityBags(metaDb)
  const entityNames = new Set(metaDb.prepare('select name from entities').all().map((r) => r.name))
  const allT = B.allTriples(metaDb)
  const factRows = new Map(metaDb.prepare('select fact_id id, content from facts').all().map((r) => [r.id, String(r.content)]))
  const entitiesByFact = metaDb.prepare('select distinct fe.fact_id fid, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id').all()

  // ── question mining ────────────────────────────────────────────────────────
  const bySubj = new Map()
  for (const t of triples) {
    if (!bySubj.has(t.subj)) bySubj.set(t.subj, [])
    bySubj.get(t.subj).push(t)
  }
  // chain: t1 = (s,p,mid) then t2 = (mid,p2,o) in a DIFFERENT fact.
  const chainQ = []
  const seenChain = new Set()
  for (const t1 of triples) {
    for (const t2 of bySubj.get(t1.obj) ?? []) {
      if (t2.fact_id === t1.fact_id) continue
      const key = `${t1.subj}|${t1.pred}|${t1.obj}|${t2.pred}`
      if (seenChain.has(key)) continue
      seenChain.add(key)
      chainQ.push({ subj: t1.subj, pred: t1.pred, mid: t1.obj, second_pred: t2.pred, gold: t2.fact_id, hop1_fact: t1.fact_id })
      if (chainQ.length >= perAction) break
    }
    if (chainQ.length >= perAction) break
  }

  // probe: entities with the most active facts (deterministic spread).
  const entFacts = new Map()
  for (const r of entitiesByFact) {
    if (!activeSet.has(r.fid)) continue
    if (!entFacts.has(r.name)) entFacts.set(r.name, new Set())
    entFacts.get(r.name).add(r.fid)
  }
  const entSorted = [...entFacts.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  // Only entities that actually have enough facts to browse; stride over THAT list so the sample
  // spans the frequency range instead of collapsing onto the three most frequent names.
  const entRich = entSorted.filter(([, s]) => s.size >= 3)
  const probeQ = []
  const step = Math.max(1, Math.floor(entRich.length / perAction))
  for (let i = 0; i < entRich.length && probeQ.length < perAction; i += step) {
    const [name, facts] = entRich[i]
    probeQ.push({ entity: name, gold: [...facts].sort((a, b) => a - b), df: facts.size })
  }

  // reason: co-occurring pairs (gold = facts containing BOTH) + pairs whose only co-occurrence is
  // in an ARCHIVED fact (the failure mode: related once, disconnected now).
  const pairFacts = new Map()
  const archivedPairFacts = new Map()
  for (const [fid, bag] of bags) {
    const arr = [...bag]
    const target = activeSet.has(fid) ? pairFacts : archivedPairFacts
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const a = arr[i] < arr[j] ? arr[i] : arr[j]
        const b = arr[i] < arr[j] ? arr[j] : arr[i]
        const k = `${a}\u0000${b}`
        if (!target.has(k)) target.set(k, new Set())
        target.get(k).add(fid)
      }
    }
  }
  const activePairs = [...pairFacts.entries()]
    .filter(([, s]) => s.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  const reasonQ = []
  for (let i = 0; i < activePairs.length && reasonQ.length < Math.ceil(perAction * 0.66); i += Math.max(1, Math.floor(activePairs.length / 8))) {
    const [k, s] = activePairs[i]
    reasonQ.push({ entities: k.split('\u0000'), gold: [...s].sort((a, b) => a - b), cooccurring: true })
  }
  const severedPairs = [...archivedPairFacts.entries()].filter(([k]) => !pairFacts.has(k))
  for (let i = 0; i < severedPairs.length && reasonQ.length < perAction; i += Math.max(1, Math.floor(severedPairs.length / 4))) {
    const [k, s] = severedPairs[i]
    reasonQ.push({ entities: k.split('\u0000'), gold: [...s].sort((a, b) => a - b), cooccurring: false, archived_only: true })
  }

  // related: entities with >=3 active facts, spread across the frequency range.
  const relatedQ = []
  const rstep = Math.max(1, Math.floor(entRich.length / perAction))
  for (let i = 0; i < entRich.length && relatedQ.length < perAction; i += rstep) {
    const [name, facts] = entRich[i]
    relatedQ.push({ entity: name, gold_facts: [...facts].sort((a, b) => a - b) })
  }

  // ── runtime ────────────────────────────────────────────────────────────────
  const emb = await B.warmEmbedder()
  const track = { runtimes: [], dirs: [work] }
  const rt = B.newRuntime({ snapPath: snap, semantic: emb, track })

  const record = { answered: 0, gold_hit: 0, gold_top3: 0, precision_top3_sum: 0, precision_top3_n: 0, narrowed: 0, narrowed_tested: 0, narrowing_empty: 0, identities_ok: 0, identities: 0, elapsed_ms: [] }
  const samples = []

  const judgeUnion = async (question, actionIds) => {
    if (actionIds === null) return null
    const union = await B.legUnionIds(rt, question, { limit: 10 })
    const subset = actionIds.every((id) => union.has(id))
    record.narrowed_tested += 1
    // An EMPTY answer is not "narrowing" — it is silence. Counted separately so the structural
    // reading ("this action can only filter the union") is not inflated by the severed-pair cases.
    if (actionIds.length === 0) record.narrowing_empty += 1
    else if (subset && actionIds.length < union.size) record.narrowed += 1
    return { action_size: actionIds.length, union_size: union.size, subset_of_union: subset, strict_narrowing: actionIds.length > 0 && subset && actionIds.length < union.size, empty: actionIds.length === 0 }
  }

  // ── chain ──────────────────────────────────────────────────────────────────
  const chainRows = []
  for (const q of chainQ) {
    const t0 = Date.now()
    const req = { action: 'chain', subj: q.subj, pred: q.pred, second_pred: q.second_pred, limit: 10 }
    const identity = await B.actionIdentity(rt, req, () => rt.memory.chain(q.subj, q.pred, q.second_pred, 10))
    record.identities += 1
    if (identity.ok) record.identities_ok += 1
    const res = await rt.recall(req)
    const got = ids(res.hits)
    const midIsEntity = entityNames.has(q.mid)
    const subjIsEntity = entityNames.has(q.subj)
    record.elapsed_ms.push(Date.now() - t0)
    if (got.length) record.answered += 1
    if (got.includes(q.gold)) record.gold_hit += 1
    if (got.slice(0, 3).includes(q.gold)) record.gold_top3 += 1
    const question = `${q.subj}的${q.pred}的${q.second_pred}`
    const narrowing = await judgeUnion(question, got)
    // Derived strings (subj/pred/mid) stay in /tmp: the artifact keeps lengths + ids only.
    chainRows.push({ subj_len: q.subj.length, pred_len: q.pred.length, mid_len: q.mid.length, second_pred_len: q.second_pred.length, gold: q.gold, hop1_fact: q.hop1_fact, mid_is_entity: midIsEntity, subj_is_entity: subjIsEntity, answered: got.length > 0, gold_hit: got.includes(q.gold), gold_top3: got.slice(0, 3).includes(q.gold), returned: got, narrowing, identity_ok: identity.ok })
    if (samples.filter((s) => s.action === 'chain').length < 6) {
      const ctx = got.slice(0, 3).map((id) => ({ fact_id: id, content: factRows.get(id) ?? '' }))
      samples.push({ action: 'chain', question, hop1: q.mid, hop1_is_entity: midIsEntity, gold_fact: q.gold, gold_content: factRows.get(q.gold) ?? '', returned: ctx })
    }
  }

  // ── probe ──────────────────────────────────────────────────────────────────
  const probeRows = []
  for (const q of probeQ) {
    const t0 = Date.now()
    const req = { action: 'probe', entity: q.entity, limit: 10 }
    const identity = await B.actionIdentity(rt, req, () => rt.memory.search({ query: q.entity, limit: 10, includeHrr: true }))
    record.identities += 1
    if (identity.ok) record.identities_ok += 1
    const res = await rt.recall(req)
    const got = ids(res.hits)
    record.elapsed_ms.push(Date.now() - t0)
    if (got.length) record.answered += 1
    const goldSet = new Set(q.gold)
    const hit = got.filter((id) => goldSet.has(id))
    if (hit.length) record.gold_hit += 1
    if (got.slice(0, 3).some((id) => goldSet.has(id))) record.gold_top3 += 1
    const top3 = got.slice(0, 3)
    record.precision_top3_sum += top3.filter((id) => goldSet.has(id)).length
    record.precision_top3_n += top3.length
    const question = `关于${q.entity}我们知道什么`
    const narrowing = await judgeUnion(question, got)
    probeRows.push({ entity_len: q.entity.length, df: q.df, gold: q.gold, answered: got.length > 0, gold_hit: hit.length, gold_top3: got.slice(0, 3).some((id) => goldSet.has(id)), precision_top3: top3.length ? hit.filter((id) => top3.includes(id)).length / top3.length : null, returned: got, narrowing, identity_ok: identity.ok })
    if (samples.filter((s) => s.action === 'probe').length < 6) samples.push({ action: 'probe', question, df: q.df, returned: got.slice(0, 3).map((id) => ({ fact_id: id, in_gold: goldSet.has(id), content: factRows.get(id) ?? '' })) })
  }

  // ── reason ─────────────────────────────────────────────────────────────────
  const reasonRows = []
  for (const q of reasonQ) {
    const t0 = Date.now()
    const req = { action: 'reason', entities: q.entities, limit: 10 }
    const identity = await B.actionIdentity(rt, req, () => rt.memory.reason(q.entities, 10))
    record.identities += 1
    if (identity.ok) record.identities_ok += 1
    const res = await rt.recall(req)
    const got = ids(res.hits)
    record.elapsed_ms.push(Date.now() - t0)
    if (got.length) record.answered += 1
    const goldSet = new Set(q.gold)
    if (got.some((id) => goldSet.has(id))) record.gold_hit += 1
    if (got.slice(0, 3).some((id) => goldSet.has(id))) record.gold_top3 += 1
    const top3 = got.slice(0, 3)
    record.precision_top3_sum += top3.filter((id) => goldSet.has(id)).length
    record.precision_top3_n += top3.length
    const question = `${q.entities[0]}和${q.entities[1]}的共同点`
    const narrowing = await judgeUnion(question, got)
    reasonRows.push({ entity_lens: q.entities.map((e) => e.length), cooccurring: q.cooccurring, annotated_archived_only: q.archived_only ?? false, gold: q.gold, answered: got.length > 0, gold_hit: got.some((id) => goldSet.has(id)), returned: got, narrowing, identity_ok: identity.ok })
    if (samples.filter((s) => s.action === 'reason').length < 6) samples.push({ action: 'reason', question, cooccurring: q.cooccurring, returned: got.slice(0, 3).map((id) => ({ fact_id: id, in_gold: goldSet.has(id), content: factRows.get(id) ?? '' })) })
  }

  // ── related ────────────────────────────────────────────────────────────────
  const relatedRows = []
  for (const q of relatedQ) {
    const t0 = Date.now()
    const req = { action: 'related', entity: q.entity, limit: 10 }
    // `related` returns `{entity,count}[]`, not hits: identity is exact over that list.
    const direct = rt.memory.related(q.entity, 10)
    const res = await rt.recall(req)
    const gotEntities = (Array.isArray(res) ? res : res.entities ?? res.hits ?? []).map((r) => r.entity)
    const identityOk = JSON.stringify(direct) === JSON.stringify(Array.isArray(res) ? res : [])
    record.identities += 1
    if (identityOk) record.identities_ok += 1
    record.elapsed_ms.push(Date.now() - t0)
    if (gotEntities.length) record.answered += 1
    // "correct" for related is not mechanical (every returned entity co-occurs by construction);
    // the informative reading is the size of the co-occurrence pool the top-10 was drawn from.
    const pool = new Set()
    for (const fid of q.gold_facts) for (const other of bags.get(fid) ?? []) if (other !== q.entity) pool.add(other)
    relatedRows.push({ entity_len: q.entity.length, df: q.gold_facts.length, cooccurrence_pool_size: pool.size, returned_count: gotEntities.length, answered: gotEntities.length > 0, identity_ok: identityOk, narrowing: null })
    if (samples.filter((s) => s.action === 'related').length < 6) samples.push({ action: 'related', question: `和${q.entity}相关的实体`, pool_size: pool.size, returned: gotEntities.slice(0, 10) })
  }

  // ── contradict: real corpus (empty log) + injected known pairs ─────────────
  const realContradict = await rt.recall({ action: 'contradict', limit: 20 })
  const realOpen = Array.isArray(realContradict) ? realContradict : realContradict.hits ?? realContradict.contradictions ?? []
  const realLogRows = metaDb.prepare('select count(*) c from contradiction_log').get().c

  const TRUE_PAIRS = [
    ['默认嵌入模型是 bge-base-zh-v1.5，维度 768。', '默认嵌入模型不是 bge-base-zh-v1.5，维度也不是 768。'],
    ['该插件在启动期会预装受管资源并校验版本。', '该插件在启动期不会预装受管资源，也不校验版本。'],
    ['检索结果按可靠性定序：精确词法命中排在前。', '检索结果不按可靠性定序，精确词法命中不排在前。'],
    ['这条记忆的 trust_score 初始值是 0.5。', '这条记忆的 trust_score 初始值不是 0.5。'],
    ['发布顺序是 base 先、插件后。', '发布顺序不是 base 先、插件后。'],
    ['向量空间变化必须触发有界后台重编码。', '向量空间变化不需要触发后台重编码。'],
  ]
  const FALSE_PAIRS = [
    ['默认嵌入模型是 bge-base-zh-v1.5，维度 768。', '本机 Node 版本是 v22，npm 走 registry 解析。'],
    ['发布顺序是 base 先、插件后。', '客户端 bundle 刷新页面即可更新，服务端要重启。'],
    ['检索结果按可靠性定序。', '数据库主从延迟与网络抖动是两回事。'],
    ['任务插件的容量是派发闸门。', 'pandoc 是文档转换的必装前提。'],
    ['三元组由启发式抽取，confidence 恒为 0.5。', '知识库切片按 token 预算切分。'],
    ['矛盾检测阈值是 0.6。', '符号链接由 link-profile 脚本安装。'],
  ]
  const contradictRows = []
  let cIdx = 0
  for (const [truth, pairs] of [['true', TRUE_PAIRS], ['false', FALSE_PAIRS]]) {
    for (const pair of pairs) {
      cIdx += 1
      const cwork = B.L.mkdtempSync(join(B.L.tmpdir(), `avantf-r6-ctr-${cIdx}-`))
      track.dirs.push(cwork)
      const csnap = join(cwork, 'memory.db')
      B.snapshotDb(B.pinSource(), csnap)
      const crt = B.newRuntime({ snapPath: csnap, semantic: emb, track })
      const a = await crt.remember({ action: 'add', content: pair[0] })
      const b = await crt.remember({ action: 'add', content: pair[1] })
      const listed = await crt.recall({ action: 'contradict', limit: 20 })
      const rows = Array.isArray(listed) ? listed : listed.hits ?? listed.contradictions ?? []
      const found = rows.some((r) => {
        const x = r.fact_a ?? r.a ?? r.fact_id
        const y = r.fact_b ?? r.b
        return (x === a.fact_id && y === b.fact_id) || (x === b.fact_id && y === a.fact_id)
      })
      contradictRows.push({ truth, fact_a: a.fact_id, fact_b: b.fact_id, logged: found, open_rows: rows.length, inline_reported: (b.contradictions ?? []).length > 0 })
    }
  }
  const trueRows = contradictRows.filter((r) => r.truth === 'true')
  const falseRows = contradictRows.filter((r) => r.truth === 'false')

  metaDb.close()

  const judgment = B.readTmp('s2-judgment.json')
  let judged = null
  if (judgment) {
    const verdicts = {}
    for (const it of judgment.items) verdicts[it.verdict] = (verdicts[it.verdict] ?? 0) + 1
    judged = { items: judgment.items.length, verdicts, correct: verdicts.correct ?? 0, correct_rate: B.ratio(verdicts.correct ?? 0, judgment.items.length), method: String(judgment.method ?? 'manual').slice(0, 180) }
  }
  const samplePath = B.writeTmp('s2-sample.json', { note: 'relation-action answers; judge each', items: samples })

  const perActionSummary = [
    { action: 'chain', questions: chainRows.length, answered: chainRows.filter((r) => r.answered).length, gold_top3: chainRows.filter((r) => r.gold_top3).length, gold_in_result: chainRows.filter((r) => r.gold_hit).length, mid_is_entity: chainRows.filter((r) => r.mid_is_entity).length, subj_is_entity: chainRows.filter((r) => r.subj_is_entity).length, note: 'gold derived from the same triple chain -> gold hit is constructive; mid_is_entity / subj_is_entity are the real readings' },
    { action: 'probe', questions: probeRows.length, answered: probeRows.filter((r) => r.answered).length, gold_top3: probeRows.filter((r) => r.gold_top3).length, precision_top3: probeRows.reduce((n, r) => n + (r.precision_top3 ?? 0), 0) / Math.max(1, probeRows.length) },
    { action: 'reason', questions: reasonRows.length, answered: reasonRows.filter((r) => r.answered).length, gold_in_result: reasonRows.filter((r) => r.gold_hit).length, cooccurring_answered: reasonRows.filter((r) => r.cooccurring && r.answered).length, cooccurring_n: reasonRows.filter((r) => r.cooccurring).length, severed_answered: reasonRows.filter((r) => !r.cooccurring && r.answered).length, severed_n: reasonRows.filter((r) => !r.cooccurring).length },
    { action: 'related', questions: relatedRows.length, answered: relatedRows.filter((r) => r.answered).length, pool_size: B.dist(relatedRows.map((r) => r.cooccurrence_pool_size)) },
    { action: 'contradict', real_log_rows: realLogRows, real_open_listed: realOpen.length, true_pairs: trueRows.length, true_logged: trueRows.filter((r) => r.logged).length, false_pairs: falseRows.length, false_logged: falseRows.filter((r) => r.logged).length, inline_true_reported: trueRows.filter((r) => r.inline_reported).length },
  ]

  const artifact = {
    card: 'round6-s2-actions',
    generated_at: new Date().toISOString(),
    node: process.version,
    loadavg: B.loadavg(),
    corpus: { active_facts: active.length, active_triples: triples.length },
    identity: { checked: record.identities, ok: record.identities_ok },
    narrowing: { tested: record.narrowed_tested, strict_narrowing: record.narrowed, empty: record.narrowing_empty },
    answered_total: record.answered,
    elapsed_ms: B.dist(record.elapsed_ms),
    per_action: perActionSummary,
    rows: { chain: chainRows, probe: probeRows, reason: reasonRows, related: relatedRows, contradict: contradictRows },
    manual_sample: { sample_file: samplePath, sample_size: samples.length, judged },
  }
  B.writeJson(outPath, artifact)
  B.L.teardown(track)
  console.log(`\nS2 identity ${record.identities_ok}/${record.identities}; narrowing ${record.narrowed}/${record.narrowed_tested}`)
  for (const p of perActionSummary) console.log(`  ${p.action}: ${JSON.stringify(p).slice(0, 200)}`)
  console.log(judged ? `judged ${judged.correct}/${judged.items}` : 'judgment not folded (write /tmp/dsh-r6/s2-judgment.json)')
}

await main()
