/**
 * Dispatch admission: which node may run next, and the unit leases that decide it.
 *
 * A `unit` is the SCOPE a mission is going to modify — a directory or a file. Two nodes that declare
 * the same unit must never run at the same time, and that guarantee is made by the engine's state,
 * never by telling executors to be careful (the same stance `decompose`/`submitResult` take toward
 * mutual exclusion, see `tree.ts`).
 *
 * ## The lease is a PROJECTION of node state, not a table
 *
 * The holder of a unit is defined as "the `running` node whose `unit` is that string", so the lease
 * exists exactly while a node is `running` and is released on EVERY path that leaves `running` —
 * `submitResult` (done), `decompose` (blocked/ready), `reclaim` (interrupted), `cancelSubworks` /
 * `cancelTree` / `failExhausted` (failed), `reconcileOnOpen` (interrupted), `destroyTree` (gone).
 * A separate mutable table would have to be released at every one of those sites, and a single missed
 * release is a permanently stuck unit; deriving it means a release cannot be forgotten, which is the
 * whole point of "the engine guarantees it".
 *
 * ## Why this cannot deadlock
 *
 * Only a `running` node holds a lease, and a `running` node never waits for another node: it either
 * `submit_mission`s or `decompose_mission`s and is immediately `blocked`. A node waiting on premises
 * is `blocked` and holds NO lease, and a node holds at most one unit, so there is no "hold one unit &
 * wait for another" edge — hence no wait-for cycle and no deadlock. The lease only ever delays a
 * candidate until the current holder stops, and the holder always stops on its own.
 *
 * Acquisition is checked under the tree lock at every transition INTO `running` (`dispatch`,
 * `adoptParked`, `adoptContinuation`), and {@link selectNextDispatchable} skips a held unit so the
 * dispatch loop does not waste a claim on a node it will refuse.
 *
 * @module @avantf/mission-core/dispatch
 */
import { DISPATCHABLE, type NodeRecord, type TreeRecord } from './types.js'

/** One tree as the admission policy sees it. Structurally satisfied by `TreeState`, so this module
 *  never imports the class that owns the state. */
export interface DispatchScope {
  readonly tree: TreeRecord
  readonly nodes: ReadonlyMap<string, NodeRecord>
}

/** Cooldown after a dispatch fails to START a worker, so a transient runtime outage cannot burn a
 * node's whole budget in a few pump cycles: exponential in the consecutive spawn failures, capped
 * so a node still retries within minutes. */
const SPAWN_BACKOFF_BASE_MS = 30_000
const SPAWN_BACKOFF_MAX_MS = 10 * 60_000

export function spawnBackoffMs(n: number): number {
  if (n <= 0) return 0
  return Math.min(SPAWN_BACKOFF_BASE_MS * 2 ** (n - 1), SPAWN_BACKOFF_MAX_MS)
}

/** Order candidates: oldest first (cross-tree fairness), then by id for stability. */
export function byCreatedAtThenId(a: NodeRecord, b: NodeRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── unit leases ─────────────────────────────────────────────────────────────

/**
 * A declared unit as stored: trimmed, and `null` for "nothing declared". A blank string is the way a
 * caller opts OUT of a lease explicitly (see `@avantf/dsh-mission`'s tool layer), and it is the same
 * value a missing field loads as, so the two cannot diverge.
 */
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * The unit a decomposed child runs under. `undefined` — the spec said nothing — INHERITS the
 * parent's unit, which is the safe default: siblings of one decomposition then cannot run at the
 * same time. An explicit value (including a blank string = "no lease") overrides that.
 */
export function resolveChildUnit(
  parentUnit: string | null,
  declared: string | null | undefined,
): string | null {
  if (declared === undefined) return parentUnit
  return normalizeUnit(declared)
}

/** Every unit currently held by a `running` node, ACROSS every tree: a collision is cross-root by
 *  nature (two owners' missions that touch one file collide exactly like two siblings), so a
 *  per-tree answer would not describe the resource. */
export function heldUnits(scopes: Iterable<DispatchScope>): ReadonlySet<string> {
  const held = new Set<string>()
  for (const scope of scopes) {
    for (const node of scope.nodes.values()) {
      if (node.status !== 'running') continue
      if (node.unit != null && node.unit !== '') held.add(node.unit)
    }
  }
  return held
}

/**
 * The `running` node holding `unit`, if any, excluding `exceptId` (the node asking). `undefined`
 * means the unit is free. The scan deliberately spans every tree, including closed ones: a running
 * node holds its lease no matter which tree it belongs to, and the safe direction is to keep the
 * unit busy rather than to hand it out twice.
 */
export function unitHolder(
  scopes: Iterable<DispatchScope>,
  unit: string,
  exceptId?: string,
): NodeRecord | undefined {
  for (const scope of scopes) {
    for (const node of scope.nodes.values()) {
      if (node.status !== 'running') continue
      if (node.unit !== unit) continue
      if (node.id === exceptId) continue
      return node
    }
  }
  return undefined
}

/** What {@link selectNextDispatchable} needs to know beyond the node states themselves. */
export interface DispatchPolicy {
  /** Node ids already spoken for in this pass; they must not be selected twice. */
  readonly exclude?: ReadonlySet<string>
  readonly now: number
  readonly isAgentLive: (sessionId: string) => boolean
}

/**
 * The next node to dispatch: `ready`/`interrupted`, oldest first across trees, excluding ones whose
 * binding still resolves to a live agent and ones whose unit another `running` node holds. A
 * vanished worker's node is reclaimed by the engine's sweep before it becomes a candidate again.
 *
 * The held-unit set is collected from EVERY scope before any candidate is judged: iteration order
 * must not decide whether a collision is seen.
 */
export function selectNextDispatchable(
  scopes: Iterable<DispatchScope>,
  policy: DispatchPolicy,
): NodeRecord | undefined {
  const all = [...scopes]
  const held = heldUnits(all)
  const exclude = policy.exclude ?? new Set<string>()
  const candidates: NodeRecord[] = []
  for (const scope of all) {
    // A closed tree is archived: it is never dispatched again.
    if (scope.tree.closedAt !== null) continue
    // No live owner means no parent for a worker, so dispatching would only burn attempts on
    // spawns that cannot happen; the tree waits for its owner to come back.
    if (!policy.isAgentLive(scope.tree.ownerSessionId)) continue
    for (const node of scope.nodes.values()) {
      if (exclude.has(node.id)) continue
      if (!DISPATCHABLE.has(node.status)) continue
      if (node.claimedBy !== null && policy.isAgentLive(node.claimedBy)) continue
      // A parked node has a session waiting to be woken, and `decompose_mission` is followed by a
      // synchronous `pump()`, so offering it here would consume the address before the owner's
      // turn could wake it — the wake path would be unreachable.
      if (node.parkedWorker !== null) continue
      // Another `running` node owns this unit: at most one executor per scope, so the candidate
      // waits for the holder to leave `running` (it always does; see the module comment).
      if (node.unit != null && held.has(node.unit)) continue
      // Cooling down after a failed START: `claimedAt` is that dispatch's time, so the backoff
      // is waited out rather than re-failing on every pump until the budget burns.
      if (node.spawnFailures > 0 && policy.now - node.claimedAt < spawnBackoffMs(node.spawnFailures)) continue
      candidates.push(node)
    }
  }
  candidates.sort(byCreatedAtThenId)
  return candidates[0]
}
