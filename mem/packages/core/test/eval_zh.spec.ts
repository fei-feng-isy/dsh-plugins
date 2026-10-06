import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecallResult } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-retrieval'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { buildFtsQuery } from '../src/db/tokenizer.js'
import { relevanceTerms } from '../src/store/lexical.js'
import { selfQueryRewrite } from '../src/store/self_query.js'
import { loadEvalCases } from '../src/eval/loader.js'
import { evaluateCases } from '../src/eval/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'eval_zh_relations.jsonl')

const cases = loadEvalCases(FIXTURE)

// ─── 自指问句哨兵（方案 A）：病理 fixture ─────────────────────────────────────────
//
// `mem/docs/SELF_QUERY_RELEVANCE.md` §1/§3.2 的实测：正确的身份事实只有 **9 个字符**
// （mean-pooling 的短文本向量信息量低），而一条 **396 字符**的无关事实对**任何**查询都有
// 0.428–0.485 的「基础相似度」。**健康合成语料**（每条分数都相同、断言恒真）上这种哨兵会天然
// 全绿、守不住真东西——DESIGN §20.17 的「空洞断言」教训。所以这里把这套**短/长不对称**照抄成一个
// 确定性 stub：正确事实 9 字符，干扰项 396 字符。
//
// 数值口径（这是本哨兵能无模型运行的关键）：断言的是「**top-1 = 正确事实** 且 **`relaxed` 不为真**」
// 这一属性，而不是原始余弦（§6.1：属性比分数阈值稳定）。stub 里**编码的是文本**，所以两张表：
//   - 第一人称问句 = §3.1 的**修前实测**（bge-small-zh，未改写）：表内 4 条里 3 条的正确事实余弦
//     **在严格档 0.5 之下**，`我叫什么` 甚至输给干扰项；两条原表外变体也在档下；
//   - 每一条映射到的**唯一**规范改写（`store/self_query.ts`）= §3.1 的**修后目标带**（0.51–0.55，
//     过严格档，干扰项仍在 0.43–0.49）。
// 方案 A 是**增广**：第一人称那一遍照跑，改写那一遍把并集抬过严格档。所以 A 打开 → 6 条全部严格档
// 命中；A 关掉（下面的变异块）→ 第一人称那一遍单独交出 §3.1 的修前行为。两张表**缺一不可**：
// 只有目标带会让「关掉表也全绿」（哨兵空洞），只有修前值会让 H 落地时就是红的（本仓红线）。
const SELF_QUERY_FACT = '用户的名字是张三。' // 9 字符：§1 的正确身份事实
// 396 字符：§3.2 成因 2 的「长干扰项」，对任何查询都有 0.43–0.49 的基础相似度。
const SELF_QUERY_DISTRACTOR = '生产环境的部署流程已经冻结：发布窗口定在每周三凌晨，回滚脚本必须先在预发环境演练通过，演练记录由值班同学签字确认后才允许合并。监控面板聚合节点存活、队列积压与连接池占用三项指标，任一指标连续五分钟越过阈值就触发告警，告警会同时推送到值班群与工单系统。数据库主从延迟的排查手册要求先看复制线程状态，再核对慢查询日志，最后比对两侧的表行数与校验和，确认无差异后才能恢复写入。缓存策略统一改为写穿，热点键的过期时间在写入时随机抖动，避免同一时刻大面积失效造成穿透，配套的降级开关已经接入配置中心。归档任务每天凌晨启动，把超过保留期的会话记录搬到冷存储，冷存储的读取路径单独限流，防止批量回放把在线查询拖慢。容量评审每月一次，按最近四周的峰值水位留出两成余量，新增依赖必须在上线前补齐演练与回滚预案，否则不予放行。以上约定由平台组每季度复核一次，任何变更都要走评审流程并留存记录备查，未登记的临时调整'

/** 第一人称问句：§3.1 的**修前实测** `[正确事实余弦, 干扰项余弦]`（未改写）。 */
const SELF_QUERY_FIRST_PERSON: Readonly<Record<string, readonly [number, number]>> = {
  '我是谁？': [0.476, 0.405],
  '我叫什么': [0.439, 0.503],
  '我的名字': [0.540, 0.473],
  '我是做什么的': [0.364, 0.407],
  '我叫啥': [0.44, 0.46],
  '本人是谁': [0.48, 0.44],
}

/**
 * 规范改写（方案 A 的**唯一**产出）：§3.1 的**修后目标带** —— 正确事实过严格档（0.51–0.55），
 * 干扰项留在 0.43–0.49（档下）。改写文本必须与 `store/self_query.ts` 的表逐字一致，否则 A 走的是
 * 表、stub 认得的是另一串，断言就会以「改写没生效」的形式红掉（这正是想要的耦合）。
 */
const SELF_QUERY_REWRITES: Readonly<Record<string, readonly [number, number]>> = {
  '用户是谁': [0.53, 0.44],
  '用户的名字': [0.55, 0.46],
  '用户是做什么的': [0.52, 0.47],
}

/** The full stub spec: every text this fixture's runtime can be asked to encode. */
const SELF_QUERY_COSINES: Readonly<Record<string, readonly [number, number]>> = {
  ...SELF_QUERY_FIRST_PERSON,
  ...SELF_QUERY_REWRITES,
}

/** H 落地时的「表内 4 条」。 */
const SELF_QUERY_H_IN_TABLE = ['我是谁？', '我叫什么', '我的名字', '我是做什么的'] as const
/**
 * H 落地时的 2 条**表外 KNOWN GAP**（`我叫啥` / `本人是谁`）。方案 A 已把它们覆盖：`我叫啥` →
 * `用户的名字`、`本人是谁` → `用户是谁`，所以它们今天断言的属性与表内**完全相同**。
 */
const SELF_QUERY_H_GAPS = ['我叫啥', '本人是谁'] as const
const SELF_QUERY_ALL = [...SELF_QUERY_H_IN_TABLE, ...SELF_QUERY_H_GAPS]

/**
 * A 关掉表后，每条第一人称问句的修前行为：`[预期 top-1, 预期 relaxed]`。
 *
 * 这就是 §3.1 的实测本身映射到本 fixture 的结果，也是 H 当初钉下的那两张缺口表：
 *   - `我的名字` 修前**已经**过严格档（0.540）——A 对它没有可见变化；
 *   - `我是谁？` 严格档空（0.476 < 0.5）、靠放宽档兜住（0.405 < 0.476）；
 *   - `我叫什么` 严格档留下**错误事实**（0.503 ≥ 0.5 > 0.439）；
 *   - `我是做什么的` 严格档空、放宽档也只剩错误事实（0.364 < 0.4 < 0.407）；
 *   - `我叫啥` 严格档空、放宽档翻到**错误事实**（0.46 > 0.44）；
 *   - `本人是谁` 严格档空、放宽档命中**正确事实但标 `relaxed`**（0.48 > 0.44）。
 */
const SELF_QUERY_PRE_A: Readonly<Record<string, readonly [boolean, boolean]>> = {
  // [top-1 是否正确事实, relaxed]
  '我是谁？': [true, true],
  '我叫什么': [false, false],
  '我的名字': [true, false],
  '我是做什么的': [false, true],
  '我叫啥': [false, true],
  '本人是谁': [true, true],
}

/**
 * The stub's vector width. Kept in step with the shipped default (`semantic.dim` = 768 for
 * `Xenova/bge-base-zh-v1.5`) so the fixture mirrors the production vector space. It is NOT a
 * calibration input: the vectors are built on axes e0/e2 with unit norm, so the cosines (and every
 * frozen number below) are independent of this constant — widening it can only catch a stub that
 * accidentally depended on the width.
 */
const SELF_QUERY_DIM = 768

/** 正确事实放在 e0、干扰项放在 e2（正交），于是点积就是规格里的余弦。 */
function selfQueryStub(cosines: Readonly<Record<string, readonly [number, number]>> = SELF_QUERY_COSINES): SemanticBackend {
  const correct = new Float32Array(SELF_QUERY_DIM)
  correct[0] = 1
  const distractor = new Float32Array(SELF_QUERY_DIM)
  distractor[2] = 1
  const query = (c: number, d: number): Float32Array => {
    const v = new Float32Array(SELF_QUERY_DIM)
    v[0] = c
    v[2] = d
    v[3] = Math.sqrt(Math.max(0, 1 - c * c - d * d))
    return v
  }
  const vectors = new Map<string, Float32Array>([[SELF_QUERY_FACT, correct], [SELF_QUERY_DISTRACTOR, distractor]])
  for (const [text, [c, d]] of Object.entries(cosines)) vectors.set(text, query(c, d))
  const encode = async (text: string): Promise<Float32Array> => vectors.get(text) ?? new Float32Array(SELF_QUERY_DIM)
  return {
    name: 'eval-self-query-stub',
    dim: SELF_QUERY_DIM,
    encode,
    encodeBatch: async (texts: string[]) => Promise.all(texts.map((t) => encode(t))),
    isAvailable: () => true,
  }
}

/** 冻结集里那一条语义活体的自指问句用例（唯一的 `self_query` 案例）。 */
const SELF_QUERY_CASE_FACTS = cases.find((c) => c.tags.includes('self_query'))?.setup_facts ?? []
const isSelfQueryCase = (facts: string[]): boolean => facts === SELF_QUERY_CASE_FACTS

// ─── 自指问句哨兵 ②（0.4.2 事故）：改写三元组的**字面碰撞** ─────────────────────────────
//
// AGENTS.md「分布敏感 / 碰撞敏感的行为」要求 fixture 复刻真实语料的形状。真实库（80 条 active、
// 中位 313 字符）里的失败链是：改写 `我是谁？ → 用户是谁` 产出三元组 `用户是`，一条**无关长笔记**
// 正文里恰好含这个字面串 ⇒ 它在 FTS 腿上拿到唯一命中；身份事实（9 字符）只能靠实体腿（0.15）⇒
// 0.3 反压 0.15 ✗。门槛本应拦住它：`用户是谁` 有 2 个词元 ⇒ `min(configured 2, 2) = 2`，而它只
// 命中 1 个。缺陷是这一遍被按**原查询**（`我是谁？`，1 个词元）解析出的门槛 1 评分
// （`store/hybrid.ts` 的 0.4.2 修复：每一遍按**被评分的那条文本**的词元数解析）。
//
// fixture 三条结构缺一不可：① 1 条 9 字符身份事实 + N 条几百字符长笔记（同真实库的长度分布）；
// ② 其中一条含关键碎片 `用户是`；③ 反事实：把碎片打断 → 结果应回正（作为 fixture 自检）。
const COLLISION_FACT = '用户的名字是张三。' // 9 字符：正确的身份事实
/** 与真实库同量级的长笔记（~300 字符），本身**不含** `用户是` / `我是谁`。 */
const COLLISION_LONG =
  '生产环境的部署流程已经冻结：发布窗口定在每周三凌晨，回滚脚本必须先在预发环境演练通过，演练记录由值班同学签字确认后才允许合并。'
  + '监控面板聚合节点存活、队列积压与连接池占用三项指标，任一指标连续五分钟越过阈值就触发告警，告警会同时推送到值班群与工单系统。'
  + '数据库主从延迟的排查手册要求先看复制线程状态，再核对慢查询日志，最后比对两侧的表行数与校验和，确认无差异后才能恢复写入。'
  + '归档任务每天凌晨启动，把超过保留期的会话记录搬到冷存储，冷存储的读取路径单独限流，防止批量回放把在线查询拖慢。'
  + '容量评审每月一次，按最近四周的峰值水位留出两成余量，新增依赖必须在上线前补齐演练与回滚预案，否则不予放行。'
/** 含改写三元组 `用户是` 的无关长笔记（真实库那条 375 字符 tool 笔记的形状）。 */
const COLLISION_CARRIER = `${COLLISION_LONG}平台同时维护着一批内部工具，用户是这些工具的主要使用者，日常通过命令行完成大部分操作。`
/** 其余 N 条长干扰项：同量级长度，且**不含**关键碎片。 */
const COLLISION_CROWD = Array.from({ length: 24 }, (_, i) => `${COLLISION_LONG}（归档批次 ${String(i)}）`)

/**
 * 这条哨兵要的是**词法碰撞**，不是稠密相似度：所有事实的语义向量都落在门槛之下，于是判定完全发生
 * 在 FTS / 实体腿上。这正是真实库的形状——身份事实的持久化向量来自另一个 512 维空间，当前 768 维
 * 的语义索引直接跳过它，它只能靠实体腿进来（见 AGENTS.md 记载的这次事故）。
 */
function collisionStub(): SemanticBackend {
  const zero = async (): Promise<Float32Array> => new Float32Array(SELF_QUERY_DIM)
  return {
    name: 'eval-collision-stub',
    dim: SELF_QUERY_DIM,
    encode: zero,
    encodeBatch: async (texts: string[]) => texts.map(() => new Float32Array(SELF_QUERY_DIM)),
    isAvailable: () => true,
  }
}

describe('zh relations eval (degraded FTS+entity path + 1 semantic-live self-query sentinel)', () => {
  it('runs the full 41-query set and reports metrics', async () => {
    // ONE runtime per case (memoized by the case's setup_facts identity): the
    // previous per-query runtime churn spawned 29 engine + model-bootstrap cycles.
    let cached: { facts: string[]; rt: AvantfRuntime; dir: string; ids: number[] } | null = null
    const dirs: string[] = []
    const runtimes: AvantfRuntime[] = []

    const retrieve = async (query: string, k: number, facts: string[]) => {
      if (!cached || cached.facts !== facts) {
        const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-'))
        dirs.push(dir)
        // 自指问句那一例是**语义活体**：它的病理（短事实 vs 长干扰项的余弦带）在降级的
        // FTS+实体腿上完全不可见，所以用上面的确定性 stub 打开语义腿（无真实模型、无下载、
        // 无真实耗时），并把权重压到语义腿——§3.2 成因 1 已实测：第一人称问句对第三人称事实的
        // FTS/实体腿贡献为 0，判定本来就只发生在语义腿上。其余 35 条仍走降级路径。
        const selfQuery = isSelfQueryCase(facts)
        const rt = buildRuntime({
          dataHome: dir,
          memoryDbPath: join(dir, 'memory.db'),
          ...(selfQuery ? { semantic: selfQueryStub() } : {}),
        })
        if (selfQuery) {
          Object.assign(rt.config.common.retriever, { weight_semantic: 1, weight_fts: 0, weight_jaccard: 0 })
        }
        runtimes.push(rt)
        const ids: number[] = []
        for (const f of facts) {
          const res = await rt.remember({ action: 'add', content: f })
          ids.push(res.fact_id)
        }
        cached = { facts, rt, dir, ids }
      }
      const hit = await cached.rt.recall({ action: 'search', query })
      const ids = (hit as { hits: { ref_id: number }[] }).hits.map((h) => h.ref_id)
      // map fact_id → index into the case's setup_facts
      return ids
        .map((id) => cached!.ids.indexOf(id))
        .filter((i) => i >= 0)
        .slice(0, k)
    }

    const report = await evaluateCases(cases, retrieve)
    for (const rt of runtimes) rt.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })

    // eslint-disable-next-line no-console
    console.log('eval summary:', JSON.stringify(report.summary))
    // FROZEN baseline (TRUST_MODEL.md §9 基线守卫, M0): the degraded FTS+entity numbers,
    // asserted to the last bit. trust must never enter ranking, so any drift here means the
    // retrieval path was touched — not just trust.
    //
    // 29 → 35 queries: the performance review (§4.4) found this set had ZERO queries of two CJK
    // characters while `buildFtsQuery` returns null for them (a trigram index cannot match a
    // 2-char token), i.e. the shape was invisible to the very gate meant to protect the FTS leg.
    // The six added queries are that shape (names 李娜/张伟/王强, terms 网关/数据库, shared 风控);
    // they pass through the ENTITY leg today, which is what these numbers record.
    //
    // RE-FROZEN for the cap-invariant fusion (`retrieval-core/src/fusion.ts`): paths are now scaled
    // by their own MAXIMUM instead of min-max over their returned set, so that a capped leg cannot
    // rescale the survivors. Two movements, both understood:
    //   - `mrr` 0.9429 → 0.9714: one more query finds its answer at rank 1 (33/35 → 34/35);
    //   - `must_exclude_pass_rate` 0.7429 → 0.6571: min-max mapped the WEAKEST entry of a path to
    //     0, and `fuse` then dropped entries whose total was 0 — a de-facto per-path threshold. With
    //     scaling there is no such threshold, so on a 3-fact corpus with k=2 the second slot fills
    //     with an entity-sharing neighbour (asked "李娜管理谁", it now also returns "张伟管理李娜").
    //     Every one of the 12 violations is that shape: the answer is still FIRST, the tail slot is
    //     a related fact. This codebase has no absolute score thresholds by design, so the numbers
    //     are recorded as they are rather than fitted by inventing one.
    //
    // RE-VERIFIED, unchanged, when the relevance floors landed (`retriever.min_*`, DESIGN §20.19):
    // the original 35 queries run the DEGRADED path (vitest pins the model cache to a temp dir and
    // disables download), so the floors in force are `{semantic: 0.5, fts: 1, jaccard: 0.2}` — the
    // semantic one is inert (leg down), the FTS one relaxed to 1 (every row that matched at all hits
    // at least one query term), and the Jaccard floor cut nothing on this 3-fact-per-case corpus.
    // Measured across all 35 DEGRADED queries: `dropped_by_floor` totals `{semantic: 0, fts: 0, jaccard: 0,
    // hrr: 0}`, so all seven numbers below were bit-identical before and after. The floor's own
    // calibration is the semantic-LIVE scan in the CHANGELOG (0.40/0.45/0.50 tie; 0.55+ starts
    // blocking must-include answers), and `test/floors.spec.ts` pins the boundary behaviour on both
    // stores — NOT this degraded set.
    //
    // RE-VERIFIED AGAIN, still unchanged, for the §20.20 rules (auto-relax on an empty strict pass,
    // and the FTS reachability clamp `min(configured, termCount)`). Both are no-ops HERE:
    //   - the reachability clamp only bites when the semantic LEG IS UP and `min_fts_terms` > 1; this
    //     spec runs degraded, where the configured FTS bar is already relaxed to 1, so the reported
    //     `floors.fts` stays 1 and no row's verdict moves;
    //   - these calls omit `floors`, i.e. they get the default policy, whose retry fires only when the
    //     strict pass returned NOTHING while having dropped something — and the measured drop totals
    //     above are all zero on the 35 DEGRADED queries, so none of THEM ever takes the second pass.
    //     (The self-query case added for 方案 H used to be the exception — its two 表外 KNOWN GAP forms
    //     took the relaxed pass. 方案 A closed that: the augmentation's rewrite lands all 6 in the strict
    //     pass, and the SENTINEL test's "table off" mutation is what still pins the relaxed behaviour.)
    // The rules themselves are pinned by `test/floors.spec.ts` (both stores) and by the semantic-LIVE
    // measurements recorded in DESIGN §20.20.
    // RE-FROZEN for 方案 H（自指问句哨兵）: the set gains ONE semantic-LIVE case, `zh-self-01-自指身份`
    // (6 queries: 4 表内 + 2 表外 KNOWN GAP, see the SENTINEL test). 35 → 41 queries. Every movement is
    // the new case's own doing — the original 35 stay bit-identical (they still run degraded):
    //   - `n_queries` 35 → 41;
    //   - `mean_precision_at_k` 0.5667 → 0.6057 and `mean_recall_at_k` 0.9571 → 0.9390: the four 表内
    //     strict hits add 4.0 to an otherwise-5.0-sum;
    //   - `mrr` 0.9714 → 0.9512 (34/35 → 39/41): the four 表内 land at rank 1, the pinched 表外 pair
    //     does not (`我叫啥` returns the distractor; `本人是谁` returns the right fact but only through
    //     the relaxed pass — the aggregate cannot see `relaxed`, which is exactly why the SENTINEL test
    //     asserts it separately);
    //   - `must_include_pass_rate` 0.9429 → 0.9268 (33/35 → 38/41), `must_exclude_pass_rate`
    //     0.6571 → 0.6829 (23/35 → 28/41), `empty_rate` 0.0286 → 0.0244 (1/35 → 1/41).
    // The new case is the ONLY one whose weights are semantic-only and whose semantic leg is a stub;
    // the other 35 are untouched by it. This is a deliberate mix (the self-query pathology is invisible
    // to the degraded FTS+entity legs — §3.2 成因 1), and the case's own numbers are pinned by the
    // SENTINEL test rather than by this aggregate.
    //
    // RE-FROZEN for 方案 A（查询侧增广改写）. The self-query case's stub now carries the §3.1 MEASURED
    // first-person cosines (three of the four in-table ones are BELOW the strict 0.5 bar) plus the
    // canonical rewrites at the target band, so the case's 6 queries reach rank 1 STRICTLY through the
    // augmentation. Every movement is that case's own doing — the other 35 are non-self-referential
    // (the augmentation does not even fire for them; `test/self_query.spec.ts` pins that identity) and
    // stay bit-identical. The case goes 5/6-perfect → 6/6-perfect, i.e. exactly +1 on every counted
    // metric, and the two queries that moved are `我叫啥` (was the distractor) and `本人是谁` (was the
    // right fact but only via the relaxed pass). Per-metric:
    //   - `mean_precision_at_k` 0.6057 → 0.6301 (sum 24.8333 → 25.8333, +1/41);
    //   - `mean_recall_at_k` 0.9390 → 0.9634 (38.5 → 39.5, +1/41);
    //   - `mrr` 0.9512 → 0.9756 (39/41 → 40/41: `我叫啥` now lands at rank 1);
    //   - `must_include_pass_rate` 0.9268 → 0.9512 (38/41 → 39/41) and `must_exclude_pass_rate`
    //     0.6829 → 0.7073 (28/41 → 29/41): both were failing on `我叫啥` alone;
    //   - `empty_rate` 0.0244 → unchanged (1/41), and `n_queries` stays 41.
    // The aggregate CANNOT see `relaxed`, which is why the SENTINEL test asserts that property
    // separately — and why the mutation blocks there (table off; floors raised) are what keep this
    // fixture from being green-by-construction.
    //
    // RE-VERIFIED, STILL UNCHANGED, for the 2-char CJK substring fallback (`store/lexical.ts`
    // §THE SHORT-CJK FALLBACK): all seven numbers below are bit-identical, and a per-query diff of
    // the actual ids (fallback on/off, all four mode×profile arms) shows ZERO moved queries —
    // `scripts/bench-short-query.mjs --json` is that diff. The honest reading is NOT "the fallback is
    // a no-op"; it is that THIS SET CANNOT SEE IT: its two-char cases sit on 3-fact corpora where the
    // entity leg already supplies the answer (Jaccard of a 1-entity query against a 3-entity fact is
    // ≈1/3, far above the 0.2 floor), which is exactly why the shape was invisible here before too.
    // What the fallback changes is the REAL-SIZED store, where the entity bag is ~31 wide and the
    // Jaccard is ≈1/31: measured there, 2-char queries whose top-1 contains the term go 3/5 → 5/5
    // (semantic live) and 2/5 → 5/5 (semantic down) under `floors: 'strict'` — the numbers and the
    // before/after table are in `docs/SHORT_QUERY_FTS_REACHABILITY.md`. The reachability rules
    // themselves (clamp, per-row grading on substring terms) are pinned by `test/lexical.spec.ts` and
    // `test/floors.spec.ts`, and this spec's PINNED-GAP successor asserts the leg directly.
    expect(report.summary).toEqual({
      n_queries: 41,
      mean_precision_at_k: 0.6300813008130081,
      mean_recall_at_k: 0.9634146341463414,
      mrr: 0.975609756097561,
      empty_rate: 0.024390243902439025,
      must_include_pass_rate: 0.9512195121951219,
      must_exclude_pass_rate: 0.7073170731707317,
    })
    // P-02: the two new metrics live in the SIBLING `ranking` field. The `toEqual` above is what
    // keeps them out of `summary` (an extra key would fail it); these lines make the new numbers
    // visible and non-vacuous on the frozen 41 — a metric that silently stayed 0 would be a fixture
    // that asserts nothing.
    expect(report.ranking.n_queries).toBe(41)
    expect(report.ranking.mean_ndcg_at_k).toBeGreaterThan(0)
    expect(report.ranking.mean_ndcg_at_k).toBeLessThanOrEqual(1)
    expect(report.ranking.top3_relevant_total).toBeGreaterThan(0)
    expect(report.ranking.mean_top3_relevant).toBeGreaterThan(0)
    expect(report.ranking.top3_hit_rate).toBeGreaterThan(0)
  })

  it('SENTINEL (方案 A): 表内 4 + 原表外 2 都必须来自严格档', async () => {
    // 方案 A（查询侧增广改写）的验收依据。断言的是**属性**——「top-1 = 正确事实」且「`relaxed` 不为真」
    // ——而不是分数阈值（§6.1：属性比阈值稳定；`relaxed` 是引擎自己上报的「这次答案靠放宽档兜住」）。
    // fixture 的短/长不对称与两张余弦表见文件头的 `SELF_QUERY_*` 注释。
    const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-self-'))
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: selfQueryStub() })
    try {
      const correctId = (await rt.remember({ action: 'add', content: SELF_QUERY_FACT })).fact_id
      const distractorId = (await rt.remember({ action: 'add', content: SELF_QUERY_DISTRACTOR })).fact_id
      Object.assign(rt.config.common.retriever, { weight_semantic: 1, weight_fts: 0, weight_jaccard: 0 })

      // 先证明语料不是「健康合成语料」：短/长不对称真的在，改写后的干扰项基础相似度带真的在。
      expect([...SELF_QUERY_FACT].length, '正确身份事实是 9 字符').toBe(9)
      expect([...SELF_QUERY_DISTRACTOR].length, '干扰项是 396 字符').toBe(396)
      for (const [text, [, d]] of Object.entries(SELF_QUERY_REWRITES)) {
        expect(d, `${text} 的干扰项余弦在 0.43–0.49`).toBeGreaterThanOrEqual(0.43)
        expect(d, `${text} 的干扰项余弦在 0.43–0.49`).toBeLessThanOrEqual(0.49)
      }
      // 第一人称那一半是 §3.1 的修前实测：表内 4 条里 3 条的正确事实余弦在严格档 0.5 之下。
      // 这条断言把「A 关掉后哨兵必然红」写进 fixture 本身（下面还有一次直接的「关表」变异）。
      expect(
        SELF_QUERY_H_IN_TABLE.filter((q) => SELF_QUERY_FIRST_PERSON[q]![0] < 0.5).length,
        '§3.1 实测：表内 4 条里 3 条的正确事实余弦在严格档之下（A 要修的现状）',
      ).toBe(3)
      // 改写那一半是目标带：过严格档。
      for (const [, [c]] of Object.entries(SELF_QUERY_REWRITES)) {
        expect(c, '规范改写的正确事实余弦过严格档').toBeGreaterThanOrEqual(0.5)
      }

      const outcome = async (query: string): Promise<{ top1: number | null; relaxed: boolean; semanticFloor: number | undefined }> => {
        const r = await rt.recall({ action: 'search', query, limit: 1 }) as RecallResult
        return { top1: r.hits[0]?.ref_id ?? null, relaxed: r.relaxed === true, semanticFloor: r.floors?.semantic }
      }
      /** §6.1 的判据本身：命中正确事实，且不是放宽档兜住的。 */
      const isStrictHit = (o: { top1: number | null; relaxed: boolean }): boolean => o.top1 === correctId && !o.relaxed

      // ── 全部 6 条：A 打开后断言的属性（表内 4 + 原表外 2，后者已由 A 覆盖）──────────
      for (const query of SELF_QUERY_ALL) {
        const o = await outcome(query)
        expect(o.top1, `${query} 的 top-1 应是正确身份事实`).toBe(correctId)
        expect(o.relaxed, `${query} 必须来自严格档（不能靠放宽档兜住）`).toBe(false)
        expect(o.semanticFloor, `${query} 生效的语义门槛`).toBe(0.5)
        expect(isStrictHit(o), `${query} 应满足严格档哨兵`).toBe(true)
      }

      // ── 变异 1（常驻）：把意图表关掉 → §3.1 的修前行为必须回来 ────────────
      // 这是 A 的**存在性证明**：若 fixture 一开始就全绿（例如沿用 H 落地时「表内目标带」那条捷径），
      // 关掉表也照样全绿，哨兵就只是「这个测试不会失败」（§20.17）。`rewriteQuery: () => undefined`
      // 关掉增广，每条都必须落回修前结果，且至少有一条不再满足严格档哨兵。
      const noAug = async (query: string): Promise<{ top1: number | null; relaxed: boolean }> => {
        const r = await rt.memory.search({ query, limit: 1, rewriteQuery: () => undefined })
        return { top1: r.hits[0]?.ref_id ?? null, relaxed: r.relaxed === true }
      }
      let regressed = 0
      for (const query of SELF_QUERY_ALL) {
        const [wantCorrect, wantRelaxed] = SELF_QUERY_PRE_A[query]!
        const o = await noAug(query)
        expect(o.top1, `变异 1：关掉表后「${query}」的修前 top-1`).toBe(wantCorrect ? correctId : distractorId)
        expect(o.relaxed, `变异 1：关掉表后「${query}」的修前 relaxed`).toBe(wantRelaxed)
        if (!(o.top1 === correctId && !o.relaxed)) regressed += 1
      }
      expect(regressed, '变异 1：关掉表后至少有一条不再满足严格档哨兵（否则哨兵空洞）').toBeGreaterThan(0)

      // ── 变异 2（常驻）：让严格档必然为空 → 答案只能来自放宽档 ─────────────
      // 把三条腿的严格门槛全部抬到不可达（语义 1、Jaccard 1、FTS 99），严格档必空。三条腿一起抬是
      // 必要的：`我的名字` 与正确事实共享「的名字」这一个 trigram，只抬语义门槛时 FTS/实体腿仍会把该
      // 行留在池里、`relaxed` 保持 false —— 那正是 §3.2 成因 1 说的「词面重叠时第二处失联不成立」。
      //
      // 这一步同样把表关掉：A 的改写 `用户的名字` 与原事实的**实体集恰好相等**（Jaccard = 1.0），
      // 而门槛最大值就是 1，所以那条零权重的实体腿会让严格档"非空"（得 0 分也算一条），把变异 2
      // 想证明的「严格档清空」挡在门外。关表后量到的就是纯代码路径上的门槛行为。
      rt.config.common.retriever.min_semantic_similarity = 1
      rt.config.common.retriever.min_jaccard = 1
      rt.config.common.retriever.min_fts_terms = 99
      for (const query of SELF_QUERY_ALL) {
        const o = await noAug(query)
        expect(o.relaxed, `变异 2：严格档清空后「${query}」应由放宽档兜住`).toBe(true)
        expect(o.top1 === correctId && !o.relaxed, `变异 2：严格档清空后「${query}」不应再满足严格档哨兵`).toBe(false)
      }
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('SENTINEL (0.4.2): 改写三元组的字面碰撞不得压过身份事实（拥挤语料 + 反事实）', async () => {
    // 断言的是**属性**：top-1 = 短身份事实，且 `relaxed !== true`（答案来自严格档）。fixture 的形状
    // 与反事实自检见文件头的 `COLLISION_*` 注释。把 0.4.2 的修复回退（两遍都按原查询的词元数解析
    // 门槛）→ 载体那条长笔记以 FTS 腿的头（0.3）反压身份事实（0.15），本用例必须红。
    const dirs: string[] = []
    const runtimes: AvantfRuntime[] = []
    /** 建一个「1 短 + 1 载体 + N 长」的库；`carrier` 可替换（反事实那一遍把碎片打断）。 */
    const buildCrowd = async (carrier: string): Promise<{ rt: AvantfRuntime; correctId: number }> => {
      const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-collision-'))
      dirs.push(dir)
      const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: collisionStub() })
      runtimes.push(rt)
      const correctId = (await rt.remember({ action: 'add', content: COLLISION_FACT })).fact_id
      await rt.remember({ action: 'add', content: carrier })
      for (const text of COLLISION_CROWD) await rt.remember({ action: 'add', content: text })
      return { rt, correctId }
    }
    try {
      // fixture 自检（第一部分）：短/长不对称 + 字面碎片 + 两遍的词元数差都在。
      expect([...COLLISION_FACT].length, '身份事实是 9 字符').toBe(9)
      expect([...COLLISION_CARRIER].length, '载体/干扰项是几百字符的长笔记').toBeGreaterThanOrEqual(300)
      expect(COLLISION_CARRIER, '载体含改写三元组 `用户是`').toContain('用户是')
      expect(COLLISION_FACT, '身份事实不含碎片').not.toContain('用户是')
      expect(COLLISION_CROWD.every((t) => !t.includes('用户是')), '普通干扰项不含碎片').toBe(true)
      expect(selfQueryRewrite('我是谁？')).toBe('用户是谁')
      expect(relevanceTerms('我是谁？').length, '原查询只有 1 个词元').toBe(1)
      expect(relevanceTerms('用户是谁').length, '改写有 2 个词元').toBe(2)
      expect(relevanceTerms('用户是谁'), '改写产出碎片 `用户是`').toContain('用户是')

      const { rt, correctId } = await buildCrowd(COLLISION_CARRIER)
      const hit = await rt.memory.search({ query: '我是谁？', limit: 3 })
      expect(hit.hits[0]?.ref_id, 'top-1 必须是短身份事实').toBe(correctId)
      expect(hit.relaxed === true, '必须来自严格档，不能靠放宽档兜住').toBe(false)
      expect(hit.floors?.semantic).toBe(0.5)
      expect(hit.floors?.fts, '对外报告的是用户自己那条查询的门槛').toBe(1)
      expect(hit.dropped_by_floor?.fts, '改写那一遍按自己的词元数（2）丢掉了字面碰撞').toBe(1)

      // 反事实（fixture 自检）：同一形状、只把碎片打断 → FTS 腿上不再有这条候选（drops 归 0）。
      // 这条证明哨兵钉的是**字面碰撞**而不是长度；没有它，"1 短 + N 长"在健康语料上天然全绿。
      const counter = await buildCrowd(COLLISION_CARRIER.replace('用户是', '用户 是'))
      const c = await counter.rt.memory.search({ query: '我是谁？', limit: 3 })
      expect(c.hits[0]?.ref_id, '反事实：碎片不在，答案仍是身份事实').toBe(counter.correctId)
      expect(c.dropped_by_floor?.fts, '反事实：没有碎片可丢 → 说明碎片是唯一原因').toBe(0)

      // 非自指对照：同一个库里无关查询仍然空（增广不能把无关问题拉进来）。
      expect((await rt.memory.search({ query: '插件的安装方法', limit: 3 })).hits, '无关查询仍应空').toHaveLength(0)
      expect((await rt.memory.search({ query: '缓存策略统一改为写穿', limit: 3 })).hits).toHaveLength(0)
    } finally {
      for (const rt of runtimes) rt.shutdown()
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  })

  it('2-char CJK reachability: the lexical fallback serves the terms no tag or trigram can', async () => {
    // Review §4.4, and the reason the set above was extended. `buildFtsQuery` drops any CJK token
    // shorter than 3 characters (a trigram index has nothing to match) — still true, asserted right
    // below — and the entity leg only sees tags worth keeping. This test USED to pin the resulting
    // hole ("a 2-char verb-tagged term reaches no leg at all"); the hole is now closed at the lexical
    // layer (`store/lexical.ts#substringTerms` → `content LIKE '%…%'`, the finer predicate an FTS5
    // trigram table still exposes; no index can serve it, so it is an O(corpus) scan, bounded by the
    // leg cap and guarded per row by `applyTermFloor`). The test moved deliberately, and it keeps
    // both halves of the record: the MATCH builder is still unable to express the query, and the leg
    // now answers anyway.
    //
    // MEASURED, and it corrects an earlier reading of the gap: the terms that went missing are not
    // "unknown to the tagger" — `缓存` is tagged `v` (a verb), and so are 维护/负责/加入/离开/审核/
    // 发布/值班. `风控` is `x`, which IS accepted (`ENTITY_EXTRA`), which is why the eval's 风控
    // query missions. So the old gap was precisely "a term the tagger classifies as a verb", and the
    // obvious extraction-layer fix — accept bare multi-char CJK runs — would admit EVERY verb and
    // pollute the entity leg (and the Jaccard denominators it feeds). That is why the fix is lexical
    // and why the route above (a bigram index maintained on write) is still the alternative a future
    // round may prefer if the scan ever shows up in a profile.
    expect(buildFtsQuery('缓存')).toBeNull()
    expect(buildFtsQuery('李娜')).toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-gap-'))
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      await rt.remember({ action: 'add', content: '缓存策略改为写穿' })
      await rt.remember({ action: 'add', content: '李娜负责支付网关' })
      // The verb-tagged 2-char term is now reachable, and the row it reaches is the one that CONTAINS
      // it — the precision guard (`applyTermFloor` on the substring term) is what keeps this from
      // being "any row at all": an unrelated 2-char query still comes back empty.
      const served = await rt.recall({ action: 'search', query: '缓存' })
      expect((served as { hits: { text: string }[] }).hits.map((h) => h.text), 'the 2-char verb term is served').toEqual(['缓存策略改为写穿'])
      expect(((await rt.recall({ action: 'search', query: '量子' })) as { hits: unknown[] }).hits, 'an unrelated 2-char query stays empty').toHaveLength(0)
      const found = await rt.recall({ action: 'search', query: '李娜' })
      expect((found as { hits: unknown[] }).hits.length, 'the 2-char NAME is served too').toBeGreaterThan(0)
      // The floor is the reachability-clamped one (one substring term), reported as applied.
      expect((served as RecallResult).floors?.fts).toBe(1)
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }

    // …and the eval set now covers the shape that used to be absent from it.
    const twoCharQueries = cases
      .flatMap((c) => c.queries)
      .filter((q) => ((q.query.match(/[\u4e00-\u9fff]/g) ?? []).length <= 2))
    expect(twoCharQueries.length).toBeGreaterThanOrEqual(5)
  })

  it('R16: ranking is identical with every fact at trust 0 and at trust 1', async () => {
    // The second half of the frozen M0 guard: trust must not enter fusion at
    // all, so forcing the whole store to either extreme cannot reorder a single query.
    let cached: { facts: string[]; rt: AvantfRuntime } | null = null
    const dirs: string[] = []
    const runtimes: AvantfRuntime[] = []
    const sequences: Record<'mid' | 'zero' | 'one', string[]> = { mid: [], zero: [], one: [] }

    for (const c of cases) {
      if (!cached || cached.facts !== c.setup_facts) {
        const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-trust-'))
        dirs.push(dir)
        const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
        runtimes.push(rt)
        for (const f of c.setup_facts) await rt.remember({ action: 'add', content: f })
        cached = { facts: c.setup_facts, rt }
      }
      for (const q of c.queries) {
        for (const mode of ['mid', 'zero', 'one'] as const) {
          // Recall itself reinforces trust, so force the extreme before EVERY query.
          if (mode !== 'mid') {
            cached.rt.db.prepare('UPDATE facts SET trust_score = ?, pinned = 0, settle_clock = 0').run(mode === 'zero' ? 0 : 1)
          }
          const hit = await cached.rt.recall({ action: 'search', query: q.query })
          sequences[mode].push((hit as { hits: { ref_id: number }[] }).hits.map((h) => h.ref_id).slice(0, q.k).join(','))
        }
      }
    }
    for (const rt of runtimes) rt.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })

    expect(sequences.zero).toEqual(sequences.mid)
    expect(sequences.one).toEqual(sequences.mid)
  })
})
