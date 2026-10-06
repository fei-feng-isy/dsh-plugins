/**
 * R3 shared fixture: a CONSTRUCTED memory corpus whose "truth" is known at construction time.
 *
 * WHY A CONSTRUCTED CORPUS. The card asks whether a CALLER-SUPPLIED structure (B1) can move
 * retrieval, at 100% / 50% / 25% / 0% compliance, under naming noise, and with a measurable schema
 * price. Answering that needs a corpus where the canonical entity / subject / attribute / event
 * date of every fact is KNOWN. Reading the user's real memory to label it is forbidden by the
 * campaign's privacy boundary (and would not be reproducible), so the fixture is built here: the
 * author knows the truth because the author wrote it.
 *
 * SHAPE, NOT A TOY. The corpus copies the shape the live store actually has (`AGENTS.md`: "80 条
 * active、中位 313 字符; 短事实 + 一堆长文本才是真实形状"), because a retrieval property measured on
 * a healthy synthetic corpus does not transfer:
 *   - 40–80 facts, with 9–14 char facts, 200–400 char notes and 800+ char long notes;
 *   - every topic entity surfaces in text only through ALIAS / case / fullwidth variants, so the
 *     baseline entity bag never holds the canonical name (this is the thing a caller could fix);
 *   - some topics ALSO have an unrelated note that carries the canonical name literally (the
 *     "collision carrier": baseline precision noise, and the population a perfect caller can prune);
 *   - a self-reference family: a third-person identity fact, a second fact sharing its subject, an
 *     unrelated long note containing the literal fragment `用户是谁` (the collision carrier), and a
 *     policy fact that mentions `用户` but is not about the user;
 *   - facts carry an EVENT date that differs from their write time, which is the only thing the
 *     caller can know and the engine cannot;
 *   - a COUNTERFACTUAL: with the carrier's `用户是谁` fragment removed, the self query must change
 *     (see the card script) — the fixture's own proof that it is not a healthy corpus.
 *
 * The corpus text is entirely synthetic (generic engineering notes); it contains no data from the
 * user's memory. The raw JSON keeps the truth (canonical names / subject / attribute / event date)
 * plus a content hash and a length per fact — never the text.
 *
 * @module scripts/spikes/bench-r3-fixture
 */
import { createHash } from 'node:crypto'

/** One seed controls every randomized-but-deterministic choice below. */
export const FIXTURE_SEED = 20261006

/** All facts are "written" at this instant; their EVENT dates are the truth the caller supplies. */
export const WRITE_TIME = '2026-10-06 09:00:00'

/** Window word -> the event date the fixture places a gold fact at. */
export const TIME_PLAN = [
  { topic: '缓存', window: '前天', gold_date: '2026-10-04', other_dates: ['2026-09-12', '2026-08-20'] },
  { topic: '部署', window: '上个月', gold_date: '2026-09-12', other_dates: ['2026-10-04', '2026-08-20'] },
  { topic: '备份', window: '2026年9月18日', gold_date: '2026-09-18', other_dates: ['2026-10-04', '2026-08-20'] },
]

/** mulberry32 — a tiny deterministic PRNG so a run is reproducible from `FIXTURE_SEED`. */
export function rng(seed = FIXTURE_SEED) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)

/** Generic engineering sentences; appended until a target length is reached. No user data. */
const FILLER = [
  '这一步需要在改动前记录基线，否则后面的对比没有意义。',
  '命令的输出被写进了日志，第二天再查时已经轮转掉了。',
  '把参数固化进配置文件之后，不同机器上的行为终于一致了。',
  '回滚脚本只覆盖了建表，索引和数据没有一起回退。',
  '压测在空库上跑出来的数字不能直接外推。',
  '权限收敛以后，只有发布账号能碰到这个目录。',
  '队列积压的告警阈值设得太低，半夜响过三次。',
  '版本号写错了一次，导致灰度只覆盖到一半实例。',
  '这条链路的中位数和长尾差了两个数量级。',
  '缓存穿透的修补方式是加一层空值占位。',
  '磁盘水位到八成时先清日志，再考虑扩容。',
  '脚本的失败重试没有退避，打满了下游的连接池。',
  '配置热加载只在部分进程上生效，需要重启补齐。',
  '导出任务放在凌晨，避免和在线流量抢带宽。',
  '监控面板只保留最近两周的曲线，更早的要翻归档。',
  '开关默认关闭，需要的人自己在配置里打开。',
  '分页接口的游标改成了不透明字符串，防止被猜到顺序。',
  '写入放大主要来自索引，去掉一个复合索引就降了一半。',
]

/** Pad `text` with generic sentences until it reaches at least `target` characters. */
export function padTo(text, target, next) {
  let out = text
  while (out.length < target) out += FILLER[Math.floor(next() * FILLER.length)]
  return out
}

/**
 * The caller's canonical name -> the names the engine's QUERY-side extractor would produce.
 *
 * A caller supplies an identifier, not a tokenisation. One fixture entity is hyphenated, and the
 * production query extractor splits it (`bge-base-zh-v1.5` -> `bge` / `base` / `zh` / `v1`), so a
 * contract that stored the raw string verbatim would never match a query naming the same entity.
 * The mapping is written down as the SUPPLIED form and recorded in the JSON, so the mismatch is
 * visible rather than hidden inside the arm.
 */
export const CALLER_NAME_MAP = { 'bge-base-zh-v1.5': ['bge', 'base', 'zh', 'v1'] }

export function callerNames(canonical) {
  return CALLER_NAME_MAP[canonical] ?? [canonical]
}

/** Every name a caller would write for a canonical entity set. */
export function supplyNames(canonicalSet) {
  return [...new Set(canonicalSet.flatMap((n) => callerNames(n)))]
}

// ─── topics: 3 facts "about" the entity (alias surfaces only) + optional literal carrier ─────────
const TOPICS = [
  { key: 'pg', canonical: 'PostgreSQL', facet: '配置', literal_carrier: true, shape: 'alias',
    surfaces: ['PG', 'pgsql', 'ＰＧ'],
    about: [
      '主库现在走 PG，写入和只读查询都落在同一个实例上，暂时没有再拆。',
      'pgsql 的连接数上限调到了 200，超过之后应用侧会排队而不是直接报错。',
      'ＰＧ 的慢查询日志打开以后，日志盘一天涨了 4 个 G，只好调低了采样率。',
    ] },
  { key: 'redis', canonical: 'Redis', facet: '内存占用', literal_carrier: true,
    surfaces: ['内存缓存', 'KV 存储', 'Ｒｅｄｉｓ'],
    about: [
      '内存缓存这一层没有开持久化，重启之后从数据库整体重建，慢几分钟但省事。',
      'KV 存储的键前缀按业务域划分，避免两个模块互相覆盖同一个键。',
      'Ｒｅｄｉｓ 的主从切换演练定在每季度一次，演练结果要求当场记录。',
    ] },
  { key: 'pandoc', canonical: 'pandoc', facet: '版本', literal_carrier: false,
    surfaces: ['文档转换器', 'Markdown 导出工具', 'ｐａｎｄｏｃ'],
    about: [
      '文档转换器负责把 Markdown 拼成一份 PDF，样式表跟着仓库一起走。',
      'Markdown 导出工具只在发布流水线里跑，本地开发机不装，省得版本打架。',
      'ｐａｎｄｏｃ 的模板目录需要单独同步，否则线上渲染出来的样式和本地不一样。',
    ] },
  { key: 'sqlite', canonical: 'SQLite', facet: '备份', literal_carrier: false,
    surfaces: ['嵌入式数据库', '单文件数据库', 'ＳＱＬｉｔｅ'],
    about: [
      '嵌入式数据库用来存本地索引，删掉整个文件就能重建，不需要迁移脚本。',
      '单文件数据库在并发写上会锁库，所以只有只读场景才敢这么用。',
      'ＳＱＬｉｔｅ 的页大小设成 4096 之后，同样的数据体积小了一截。',
    ] },
  { key: 'xianliu', canonical: '限流', facet: '阈值', literal_carrier: true,
    surfaces: ['流量控制', '限速保护', '令牌桶'],
    about: [
      '流量控制在网关层做，按租户维度分配令牌，应用侧不再自己计数。',
      '限速保护触发时直接拒绝请求，而不是排队等待，这一点和上一版行为不同。',
      '令牌桶的容量按峰值的三倍配置，突发流量可以短时间放行。',
    ] },
  { key: 'bge', canonical: 'bge-base-zh-v1.5', facet: '维度', literal_carrier: false,
    surfaces: ['中文向量模型', '本地向量模型', '中文嵌入模型'],
    about: [
      '中文向量模型换过一次，维度也跟着变了，旧向量只能整体重编码。',
      '本地向量模型在纯 CPU 上编码一批要十几秒，后台任务必须分批跑。',
      '中文嵌入模型的池化方式是均值，输出做归一化之后才能比较余弦。',
    ] },
  // The R2-8 shape: the canonical name IS a literal substring of the fact text. Here a caller's
  // canonical entity can add no RECALL (R2-8 measured exactly that on the live store: 2803/2803
  // (fact, entity) pairs already carried the name verbatim) — only precision and bag width.
  { key: 'kafka', canonical: 'Kafka', facet: '消费位点', literal_carrier: false, shape: 'literal',
    surfaces: ['Kafka'],
    about: [
      'Kafka 的消费位点存在本地磁盘，换机器之后要重新对账。',
      'Kafka 的副本数设成了三，尽量分散在不同机架上。',
      'Kafka 的压缩方式按主题分别配置，日志主题不压缩。',
    ] },
  { key: 'nginx', canonical: 'nginx', facet: '日志格式', literal_carrier: false, shape: 'literal',
    surfaces: ['nginx'],
    about: [
      'nginx 的配置按站点拆分，改一个站点不会影响另一个。',
      'nginx 在前面挡一层，证书和访问控制都在这里做。',
      'nginx 的日志格式加了请求耗时字段，方便看长尾。',
    ] },
]

const CARRIERS = {
  pg: '基础组件清单：PostgreSQL 被列进了本季度的替换候选，评审安排在下周。',
  redis: '缓存选型记录：Redis 和另外两个方案做过对比，最后按运维成本拍板。',
  xianliu: '值班手册：限流相关的告警先看网关指标，再看上游的并发数。',
}

// ─── self-reference family ──────────────────────────────────────────────────────────────────────
const SELF_FACTS = [
  { key: 'self-identity', text: '用户名叫张伟，常驻上海。', truth: { entities: ['用户', '张伟'], subject: '用户', attribute: '姓名' } },
  { key: 'self-contact', text: '用户的邮箱是 zhangwei@example.com，工作日的白天在看。', truth: { entities: ['用户', '邮箱'], subject: '用户', attribute: '邮箱' } },
  // The collision carrier: an unrelated long note that happens to contain the rewritten self query
  // `用户是谁` VERBATIM (both of its trigrams). Its subject is the report, not the user.
  { key: 'self-carrier', carrier: true,
    head: '本周运营周报：新增会话 3 个，其中活跃用户是谁来统计的还没定，先按登录去重。',
    truth: { entities: ['运营周报', '活跃统计'], subject: '运营周报', attribute: '统计口径' } },
  { key: 'self-policy', text: '客服在处理用户投诉之前，必须先核对订单号再回话。', truth: { entities: ['客服', '投诉流程'], subject: '客服', attribute: '流程' } },
]

// ─── time family: three facts per topic, close in meaning, separated ONLY by their event date ────
const TIME_BODIES = {
  缓存: [
    '缓存失效策略这个窗口里改成按写入时间过期，命中率掉了几个点，先观察。',
    '缓存失效策略在这个窗口里只改了预热顺序，命中率基本没动。',
    '缓存失效策略在这个窗口里回滚过一次，改回了按访问时间过期。',
  ],
  部署: [
    '部署窗口固定在这一天的晚上，预检、灰度、全量三段依次走完。',
    '部署窗口在这个时间段的周三晚上，避开业务高峰，灰度放一个实例。',
    '部署窗口在这一天的凌晨，只做预检和灰度，全量留到下一次。',
  ],
  备份: [
    '备份任务在这一天跑了一次全量，恢复演练随后跟上，记录在值班表里。',
    '备份任务在这个窗口里只跑了增量，全量留到周末的对象存储归档。',
    '备份任务在这一天的凌晨跑失败，重试后在下午补了一次全量。',
  ],
}
const TIME_DISTRACTOR = '容量评审的结论：上个月磁盘水位回落，暂不扩容，下个季度再看。'

// ─── filler: short facts, medium notes, long notes (the real length distribution) ───────────────
const SHORT = [
  '提交前跑一次全量自测。', '周五下午不做发布。', '备份统一保留三十天。',
  '告警统一发到值班群。', '日志默认保留七天。', '灰度先放一个实例。',
  '回滚窗口是十五分钟。', '密码每季度轮换一次。', '变更必须双人复核。',
]
const MEDIUM = [
  { head: '发布流程在这一版里加了预检环节，预检不过就不允许往下走。', e: ['发布流程', '预检'] },
  { head: '灰度策略按实例比例放量，每一步之间强制等待观察窗口。', e: ['灰度策略', '观察窗口'] },
  { head: '日志采集换成边车模式之后，宿主机上不再需要装采集器。', e: ['日志采集', '边车'] },
  { head: '磁盘水位告警分了两级，八成提醒，九成直接找值班的人。', e: ['磁盘水位', '告警分级'] },
  { head: '数据库连接池的空闲回收时间调短之后，长事务的报错变多了。', e: ['连接池', '长事务'] },
  { head: '镜像构建缓存放在内网仓库里，跨机器复用需要同一份基础镜像。', e: ['镜像构建', '缓存'] },
  { head: '配置中心的下发有延迟，改完要等一轮心跳才在所有实例上生效。', e: ['配置中心', '下发延迟'] },
  { head: '定时任务的重叠执行靠一把分布式锁挡住，锁的过期时间要够短。', e: ['定时任务', '分布式锁'] },
  { head: '对象存储的生命周期规则把三个月前的归档挪到低频层。', e: ['对象存储', '生命周期'] },
  { head: '接口鉴权从静态令牌换成了短期凭证，客户端需要支持刷新。', e: ['接口鉴权', '短期凭证'] },
  { head: '压测脚本的并发梯度是手动指定的，没有做自动寻峰。', e: ['压测脚本', '并发梯度'] },
  { head: '错误码在网关层统一收口，业务侧不再自己拼提示文案。', e: ['错误码', '网关'] },
  { head: '消息队列的消费位点存在本地磁盘，机器换了就要重新对账。', e: ['消息队列', '消费位点'] },
  { head: '索引重建安排在低峰期，重建期间查询会走全表扫描。', e: ['索引重建', '低峰期'] },
  { head: '审计日志单独存一份，和业务库的保留策略分开管理。', e: ['审计日志', '保留策略'] },
  { head: '容器的基础镜像打了安全补丁标签，扫描不过就不允许发布。', e: ['基础镜像', '安全补丁'] },
  { head: '跨机房同步走的是异步复制，切换时需要人工确认延迟水位。', e: ['跨机房同步', '异步复制'] },
  { head: '发布单的审批链在工具里固化了，跳步需要额外的说明字段。', e: ['发布单', '审批链'] },
  { head: '慢查询的采样率调低之后，长尾问题的定位变慢了不少。', e: ['慢查询', '采样率'] },
  { head: '证书到期前三十天开始提醒，自动续期只覆盖了内网域名。', e: ['证书', '自动续期'] },
]
const LONG_HEADS = [
  '事故复盘记录：凌晨的批量任务把连接池占满，线上查询大面积超时。',
  '架构评审纪要：把同步调用改成事件驱动，代价是链路更难追。',
  '容量规划笔记：按过去三个月的增长曲线估算，明年需要再扩一组机器。',
  '安全加固清单：对外暴露的端口逐个确认用途，能关的一律关掉。',
  '数据迁移方案：先双写再切读，最后停写，整个过程持续两个发布周期。',
  '监控体系梳理：指标、日志、链路三者的采集边界重新划了一次。',
  '运维手册摘要：常见故障的分诊顺序和升级路径，按影响面排序。',
  '成本优化记录：把冷数据挪出高性能存储之后，账单降了大约三成。',
]

/** Build one fixture fact record. `content` exists only in memory (never written to JSON). */
function fact(key, group, role, content, truth, event_date) {
  return {
    key, group, role,
    content,
    len: content.length,
    sha12: sha12(content),
    truth: {
      entities: truth.entities,
      subject: truth.subject ?? null,
      attribute: truth.attribute ?? null,
      event_date: event_date ?? null,
    },
  }
}

/**
 * Build the whole corpus, deterministically. Returns `{ facts, queries, assertions, plan }`.
 *
 * `facts[i].content` is the only field that must never leave the process; `truth` is the value the
 * "perfect caller" arm supplies, and it is what the raw JSON records.
 */
export function buildFixture() {
  const next = rng()
  const facts = []
  const plan = { topics: [], carriers: [], time: [], counts: {} }

  // 1. topic groups — 3 "about" facts per topic, surfaces only; optional literal carrier.
  for (const t of TOPICS) {
    const ids = []
    const aboutIds = []
    t.about.forEach((head, i) => {
      const target = [180, 250, 320][i] ?? 250
      const content = padTo(head, target, next)
      ids.push(facts.length)
      aboutIds.push(facts.length)
      facts.push(fact(`topic-${t.key}-${i}`, 'topic', 'about', content,
        { entities: [t.canonical, t.facet], subject: t.canonical, attribute: t.facet }, null))
    })
    if (t.literal_carrier) {
      const content = padTo(CARRIERS[t.key], 380, next)
      ids.push(facts.length)
      facts.push(fact(`carrier-${t.key}`, 'topic', 'literal-carrier', content,
        { entities: ['基础组件', '清单'], subject: '基础组件', attribute: '清单' }, null))
      plan.carriers.push(`${t.key}@${facts.length - 1}`)
    }
    plan.topics.push({ key: t.key, canonical: t.canonical, facet: t.facet, surfaces: t.surfaces,
      literal_carrier: t.literal_carrier, shape: t.shape ?? 'alias', fact_indices: ids, about_indices: aboutIds })
  }

  // 2. self-reference family.
  for (const s of SELF_FACTS) {
    const content = s.carrier ? padTo(s.head, 820, next) : s.text
    facts.push(fact(s.key, 'self', s.carrier ? 'collision-carrier' : 'fact', content, s.truth, null))
  }

  // 3. time family — three near-duplicate facts per topic, separated only by event date.
  TIME_PLAN.forEach((tp, ti) => {
    const bodies = TIME_BODIES[tp.topic]
    const dates = [tp.gold_date, ...tp.other_dates]
    const ids = []
    bodies.forEach((body, i) => {
      const content = padTo(body, 150 + i * 40, next)
      ids.push(facts.length)
      facts.push(fact(`time-${ti}-${i}`, 'time', i === 0 ? 'gold' : 'sibling', content,
        { entities: [tp.topic, '窗口'], subject: tp.topic, attribute: '窗口' }, dates[i]))
    })
    plan.time.push({ topic: tp.topic, window: tp.window, gold_date: tp.gold_date, gold_index: ids[0], fact_indices: ids })
  })

  // 4. filler — the length distribution's body.
  for (const head of SHORT) facts.push(fact(`short-${facts.length}`, 'filler', 'short', head, { entities: ['规范', '约定'], subject: '规范', attribute: '约定' }, null))
  for (const m of MEDIUM) {
    const content = padTo(m.head, 240 + Math.floor(next() * 240), next)
    facts.push(fact(`medium-${facts.length}`, 'filler', 'medium', content, { entities: m.e, subject: m.e[0], attribute: m.e[1] }, null))
  }
  for (const head of LONG_HEADS) {
    const content = padTo(head, 820 + Math.floor(next() * 380), next)
    facts.push(fact(`long-${facts.length}`, 'filler', 'long', content, { entities: ['复盘', '记录'], subject: '复盘', attribute: '记录' }, null))
  }
  // The window-word distractor (kept out of the filler pool so its role is explicit).
  facts.push(fact('time-distractor', 'time', 'distractor', padTo(TIME_DISTRACTOR, 830, next),
    { entities: ['容量评审', '结论'], subject: '容量评审', attribute: '结论' }, '2026-09-25'))

  // ── fixture self-checks: the shape must be the shape the card claims ─────────────────────────
  const assertions = []
  for (const t of plan.topics) {
    for (const idx of t.fact_indices) {
      const f = facts[idx]
      if (f.role !== 'about') continue
      // alias-shape topics: the about-facts must NOT carry the canonical literal (the caller's
      // contribution is recall). literal-shape topics: they MUST (the caller's contribution can only
      // be precision/bag width — the R2-8 shape).
      assertions.push(t.shape === 'literal'
        ? { id: `literal-present-${f.key}`, ok: f.content.includes(t.canonical), note: `literal-shape about-fact carries the canonical name (${t.key})` }
        : { id: `no-literal-${f.key}`, ok: !f.content.includes(t.canonical), note: `alias-shape about-fact must not carry the canonical literal (${t.key})` })
    }
  }
  for (const c of plan.carriers) {
    const [, idx] = c.split('@')
    const f = facts[Number(idx)]
    const canonical = plan.topics.find((t) => c.startsWith(`${t.key}@`))?.canonical
    assertions.push({ id: `carrier-literal-${f.key}`, ok: f.content.includes(canonical),
      note: 'literal carrier must carry the canonical literal' })
  }
  const carrier = facts.find((f) => f.key === 'self-carrier')
  assertions.push({ id: 'self-carrier-fragment', ok: carrier.content.includes('用户是谁'),
    note: 'the self collision carrier must carry the rewritten query literal' })
  const identity = facts.find((f) => f.key === 'self-identity')
  assertions.push({ id: 'identity-no-fragment', ok: !identity.content.includes('用户是'),
    note: 'the identity gold must NOT carry the colliding fragment' })
  assertions.push({ id: 'distractor-window-word', ok: facts.find((f) => f.key === 'time-distractor').content.includes('上个月'),
    note: 'the window-word distractor must carry a window word' })
  for (const tp of plan.time) {
    const f = facts[tp.gold_index]
    assertions.push({ id: `time-gold-date-${tp.topic}`, ok: f.truth.event_date === tp.gold_date,
      note: `gold of ${tp.topic} carries its planned event date` })
  }
  assertions.push({ id: 'content-unique', ok: new Set(facts.map((f) => f.content)).size === facts.length,
    note: 'every fact text is distinct' })

  const lens = facts.map((f) => f.len).sort((a, b) => a - b)
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))]
  plan.counts = {
    total: facts.length,
    min: lens[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: lens[lens.length - 1],
    bands: {
      le_20: lens.filter((n) => n <= 20).length,
      to_100: lens.filter((n) => n > 20 && n <= 100).length,
      to_500: lens.filter((n) => n > 100 && n <= 500).length,
      to_1000: lens.filter((n) => n > 500 && n <= 1000).length,
      over_1000: lens.filter((n) => n > 1000).length,
    },
  }

  // ── queries ─────────────────────────────────────────────────────────────────────────────────
  const selfGold = [facts.findIndex((f) => f.key === 'self-identity'), facts.findIndex((f) => f.key === 'self-contact')]
  const queries = {
    entity: plan.topics.map((t) => ({ id: `ent-${t.key}`, kind: 'entity', query: t.canonical,
      canonical: t.canonical, shape: t.shape, gold_indices: t.about_indices, literal_carrier: t.literal_carrier })),
    self: ['我是谁？', '我叫什么', '我的名字'].map((q, i) => ({ id: `self-${i}`, kind: 'self', query: q, gold_indices: selfGold })),
    time: plan.time.map((tp, i) => ({ id: `time-${i}`, kind: 'time', query: `${tp.topic} ${tp.window}`,
      topic: tp.topic, window: tp.window, gold_indices: [tp.gold_index], fact_indices: tp.fact_indices })),
    guards: ['缓存', '部署', '备份'].map((t) => ({ id: `guard-${t}`, kind: 'guard', query: t, gold_indices: null })),
  }
  plan.self_keys = SELF_FACTS.map((s) => s.key)
  plan.distractor_key = 'time-distractor'
  plan.carrier_key = 'self-carrier'

  return { facts, queries, assertions, plan }
}

/** The fixture truth as a JSON-safe table (no text, no `content`/`text` keys, hash + length only). */
export function truthTable(fixture) {
  return fixture.facts.map((f, i) => ({
    index: i, key: f.key, group: f.group, role: f.role, len: f.len, sha256_12: f.sha12,
    canonical_entities: f.truth.entities, subject: f.truth.subject,
    attribute: f.truth.attribute, event_date: f.truth.event_date,
  }))
}
