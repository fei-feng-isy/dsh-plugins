/**
 * The two page/result defaults the engine falls back to when neither the caller nor the config says
 * anything — spelled ONCE, because each of them used to be written in two or three places.
 *
 * They are the ENGINE's consumption points of numbers the CONTRACT documents:
 *
 *   - `DEFAULT_SEARCH_LIMIT` — `query`'s own input schema carries `.default(10)`
 *     (`contract/src/tools.ts`), and the recall actions' descriptions say "默认 10"; the recall union
 *     itself is `.optional()`, so the engine is what applies it. It reaches `hybridSearch` (a
 *     non-finite limit) and the cross-store router.
 *   - `DEFAULT_LIST_LIMIT` — the documented page for `admin list` and `kb_list` ("默认 50" /
 *     "缺省 50", same file).
 *
 * The cross-layer equation is pinned by `test/hybrid.spec.ts` against the contract's parsed schema,
 * so a contract default moving and this constant not moving is a red test rather than a silent
 * off-by-page behaviour. (These live here rather than in the contract because `@avantf/mem-contract`
 * is consumed as built output: a constant added there is only visible to this engine after the
 * contract is rebuilt, which a source-only change may not assume.)
 *
 * @module defaults
 */

/** Page of a recall/query result when the caller gave no usable `limit`. */
export const DEFAULT_SEARCH_LIMIT = 10

/** Page of a listing surface (`admin list`, `kb_list`) when the caller gave no `limit`. */
export const DEFAULT_LIST_LIMIT = 50
