/**
 * P-11 · the deterministic Chinese time-expression parser behind the (default-OFF) time-window leg.
 *
 * WHAT THIS IS. One pure function that turns a query's own text into ONE half-open window
 * `[start, end)` in epoch milliseconds, plus the `rule` that produced it. It has no clock of its
 * own — `now` is a parameter (default `new Date()`), so a caller can pin it ("pinned_now") and get
 * bit-identical answers from any machine. No third-party date library, no locale data: only `Date`
 * and regexes.
 *
 * WHY THE LEG NEEDS IT AT ALL. "上个月做了什么" carries its evidence in the TIME EXPRESSION, not in
 * the words: the fact that answers it reads "完成了支付网关的重构" and shares no query term. No
 * lexical, entity or semantic leg can see that; the window is the only usable signal.
 *
 * PARITY WITH THE BENCHMARK HARNESS. The rules, boundaries and `rule` names mirror
 * `scripts/spikes/bench-r4-lib.mjs`'s `parseTimeWindow` verbatim (that is the copy the A2 derived
 * "time" shape and the round-4/round-6 cards already use to pick their windows). The benchmark
 * harness is NOT modified, so a production/harness disagreement would show up as an unreproducible
 * measurement — keep the two in step. The ONE intended addition here is Chinese numerals in
 * `最近N天` ("最近三天"), which the spike's `\d+` cannot express.
 *
 * WHAT IT DELIBERATELY DOES NOT PARSE. Quarter words (`上季度`, `第三季度`) and anything else outside
 * the table below return `undefined` rather than a guess: a wrong window would silently boost the
 * wrong facts, and "no window" only leaves the other legs exactly as they were.
 *
 * @module store/time_window
 */

/** Milliseconds in a day. Rolling windows use it the way the spike does (no DST in the zh corpus). */
export const DAY_MS = 86_400_000

/** One parsed window. `end` is EXCLUSIVE. */
export interface TimeWindow {
  /** Inclusive start, epoch ms. */
  start: number
  /** Exclusive end, epoch ms. */
  end: number
  /** The spike's rule label (also what the benchmark reports as the query's time shape). */
  rule: string
  /** The literal span that matched, verbatim. */
  matched: string
}

/** Inclusive local-day bounds, the form the SQL predicate compares `valid_from`'s date prefix with. */
export interface DayBounds {
  from: string
  to: string
}

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** Monday-based week start, like the spike (`getDay()` is Sunday-based). */
const startOfWeek = (d: Date): Date => {
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
}

const CN_DIGIT: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/**
 * Parse an arabic or Chinese cardinal (`3`, `三`, `十`, `十三`, `二十一`) for the `最近N天` window.
 *
 * Capped at what a day count can plausibly be: values above 99 are treated as unparseable rather
 * than silently producing a decade-long window. Returns `undefined` when the text is not a number
 * this grammar knows, so the caller can fall through to the next rule.
 */
export function parseCount(text: string): number | undefined {
  const trimmed = text.trim()
  if (/^\d+$/u.test(trimmed)) {
    const n = Number(trimmed)
    return n > 0 && n <= 99 ? n : undefined
  }
  const chars = [...trimmed]
  if (chars.length === 0 || chars.length > 3) return undefined
  if (trimmed === '十') return 10
  const tenAt = chars.indexOf('十')
  if (tenAt === -1) {
    if (chars.length !== 1) return undefined
    const d = CN_DIGIT[chars[0]!]
    return d === undefined || d === 0 ? undefined : d
  }
  // `十三` = 13, `二十一` = 21, `三十` = 30.
  const tensChar = chars.slice(0, tenAt)
  const onesChar = chars.slice(tenAt + 1)
  const tens = tensChar.length === 0 ? 1 : tensChar.length === 1 ? CN_DIGIT[tensChar[0]!] : undefined
  const ones = onesChar.length === 0 ? 0 : onesChar.length === 1 ? CN_DIGIT[onesChar[0]!] : undefined
  if (tens === undefined || ones === undefined) return undefined
  const n = tens * 10 + ones
  return n > 0 && n <= 99 ? n : undefined
}

/** `最近N天` where N is arabic or Chinese (`最近 3 天` / `最近三天` / `最近二十一天`). */
const RECENT_DAYS_RE = /最近\s*(\d+|[零〇一二两三四五六七八九十]+)\s*[天日]/u

/**
 * The first time window in `text`, or `undefined` when the text carries no expression from the
 * table. Ordered ABSOLUTE before RELATIVE (the spike's order): a text naming a concrete date must
 * not be re-read as a relative one.
 */
export function parseTimeWindow(text: string, now: Date = new Date()): TimeWindow | undefined {
  const q = text
  const day0 = startOfDay(now)
  const at = (start: Date, end: Date, rule: string, matched: string): TimeWindow =>
    ({ start: start.getTime(), end: end.getTime(), rule, matched })

  let m = q.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/u)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (!Number.isNaN(s.getTime())) return at(s, new Date(s.getTime() + DAY_MS), 'yyyy年m月d日', m[0])
  }
  m = q.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (!Number.isNaN(s.getTime())) return at(s, new Date(s.getTime() + DAY_MS), 'yyyy-m-d', m[0])
  }
  m = q.match(/(\d{4})年(\d{1,2})月(?!\d)/u)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, 1)
    if (!Number.isNaN(s.getTime())) return at(s, new Date(s.getFullYear(), s.getMonth() + 1, 1), 'yyyy年m月', m[0])
  }
  m = q.match(/(\d{1,2})月(\d{1,2})日/u)
  if (m) {
    const s = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
    if (!Number.isNaN(s.getTime())) return at(s, new Date(s.getTime() + DAY_MS), 'm月d日(current year)', m[0])
  }
  m = q.match(RECENT_DAYS_RE)
  if (m) {
    const n = parseCount(m[1]!)
    if (n !== undefined) return { start: now.getTime() - n * DAY_MS, end: now.getTime(), rule: '最近N天', matched: m[0] }
  }
  if (/最近\s*(?:一周|一星期|7天|七天|7日|七日)/u.test(q)) {
    return { start: now.getTime() - 7 * DAY_MS, end: now.getTime(), rule: '最近一周', matched: '最近一周' }
  }
  if (/最近\s*(?:一个月|1个月|30天|三十天)/u.test(q)) {
    return { start: now.getTime() - 30 * DAY_MS, end: now.getTime(), rule: '最近一个月', matched: '最近一个月' }
  }
  if (/今天|今日/u.test(q)) return at(day0, new Date(day0.getTime() + DAY_MS), '今天', '今天')
  if (/昨天|昨日/u.test(q)) return at(new Date(day0.getTime() - DAY_MS), day0, '昨天', '昨天')
  if (/前天/u.test(q)) return at(new Date(day0.getTime() - 2 * DAY_MS), new Date(day0.getTime() - DAY_MS), '前天', '前天')
  if (/本周|这周|本星期/u.test(q)) {
    const s = startOfWeek(now)
    return at(s, new Date(s.getTime() + 7 * DAY_MS), '本周', '本周')
  }
  if (/上周|上星期|上个星期/u.test(q)) {
    const s = startOfWeek(now)
    return at(new Date(s.getTime() - 7 * DAY_MS), s, '上周', '上周')
  }
  if (/上个月|上月/u.test(q)) {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return at(s, new Date(now.getFullYear(), now.getMonth(), 1), '上个月', '上个月')
  }
  if (/这个月|本月/u.test(q)) {
    const s = new Date(now.getFullYear(), now.getMonth(), 1)
    return at(s, new Date(now.getFullYear(), now.getMonth() + 1, 1), '这个月', '这个月')
  }
  if (/去年/u.test(q)) {
    const s = new Date(now.getFullYear() - 1, 0, 1)
    return at(s, new Date(now.getFullYear(), 0, 1), '去年', '去年')
  }
  if (/今年/u.test(q)) {
    const s = new Date(now.getFullYear(), 0, 1)
    return at(s, new Date(now.getFullYear() + 1, 0, 1), '今年', '今年')
  }
  return undefined
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD` for an epoch-ms instant (the form `valid_from`'s prefix is compared against). */
export function localDayString(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * The INCLUSIVE local-day bounds of a window, for a `substr(valid_from,1,10) BETWEEN ? AND ?`
 * predicate.
 *
 * `end` is exclusive in epoch terms, and an event time is stored at day granularity (`2026-09-15`)
 * or finer; `end - 1ms` therefore names the last DAY the window can contain. That is what makes
 * `最近三天` include today (`end` is "now", so `end - 1ms` is still today) while `上个月` stops at
 * the month's last day (`end` is the 1st, so `end - 1ms` is the last day of the previous month)
 * instead of leaking the 1st of the current one.
 *
 * An empty or inverted window yields `from > to`, and the SQL `BETWEEN` then matches nothing —
 * the honest answer for "最近0天".
 */
export function windowDayBounds(window: TimeWindow): DayBounds {
  return { from: localDayString(window.start), to: localDayString(window.end - 1) }
}
