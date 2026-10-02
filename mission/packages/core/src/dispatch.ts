/**
 * Dispatch admission: which node may run next, and the unit leases and capacity gates that decide it.
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
 * ## Admission is a DISPATCH gate, never an ACCEPTANCE gate
 *
 * `create_mission` / `decompose_mission` never fail for capacity. The tree is built and a node enters
 * `ready` — that IS the queue. Being skipped here is not a refusal: it charges no `attempts`, no
 * `failures`, no `spawnFailures`, sets no cooldown and records no stall. It only means "not this
 * moment"; the next completion or sweep re-evaluates. This is the same discipline the unit lease has
 * always used (see {@link selectNextDispatchable}).
 *
 * ## Capacity, and work-conserving filling
 *
 * A candidate is admissible only while `Σ running.weight + candidate.weight ≤ capacity` (and the
 * `maxConcurrent` slot ceiling is not reached — capacity is the master gate, slots are the backstop).
 * A candidate that does not fit is SKIPPED and the scan continues, so a heavy mission at the head of
 * the queue does not idle capacity a lighter mission could use.
 *
 * A node repeatedly skipped for capacity eventually RESERVES the machine: past `agingMs` of waiting,
 * no new node is admitted until the reserved one fits (`planDispatch`'s `reserved` flag). Several
 * reserved nodes are served oldest-wait-first. A node whose `weight > capacity` ("give me the whole
 * machine") can never fit beside anything, so it is dispatched exactly when nothing else is running —
 * the same rule, expressed arithmetically, which keeps it from waiting forever. Queue order is FIFO
 * by enqueue time (`byCreatedAtThenId`) with aging promotion — deliberately NOT weight order.
 *
 * ## Why this cannot deadlock
 *
 * Only a `running` node holds a lease, and a `running` node never waits for another node: it either
 * `submit_mission`s or `decompose_mission`s and is immediately `blocked`. A node waiting on premises
 * is `blocked` and holds NO lease, and a node holds at most one unit, so there is no "hold one unit &
 * wait for another" edge — hence no wait-for cycle and no deadlock. The lease only ever delays a
 * candidate until the current holder stops, and the holder always stops on its own. Capacity is the
 * same shape: every running node ends (submits, decomposes, or is reclaimed), so the reservation
 * always drains.
 *
 * Acquisition is checked under the tree lock at every transition INTO `running` (`dispatch`,
 * `adoptParked`, `adoptContinuation`): the unit lease AND — when the caller supplies its policy — the
 * capacity gate, through the same {@link capacityWaitingFor} judgement this module plans with. The
 * plan is a decision taken from a snapshot taken OUTSIDE that lock, so two passes can each see an
 * empty machine; re-running the arithmetic against the LIVE load under the lock is what keeps the
 * two of them from binding at once. {@link selectNextDispatchable} skips a held unit so the dispatch
 * loop does not waste a claim on a node it will refuse.
 *
 * @module @avantf/mission-core/dispatch
 */
import { normalizeWeight } from './capacity.js'
import { DISPATCHABLE, type NodeRecord, type TreeRecord, type WaitingFor } from './types.js'

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

/**
 * A child's weight. `undefined` — the spec said nothing — does NOT inherit the parent's estimate:
 * a parent that needs 8 cores may be split into children that need 1 each, and inheriting would
 * re-serialize work the decomposition just made parallel. Anything declared is clamped by
 * {@link normalizeWeight}, the same normalizer every other entry point uses.
 */
export function resolveChildWeight(declared: number | undefined): number {
  return normalizeWeight(declared)
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

// ── capacity gate ───────────────────────────────────────────────────────────

/**
 * The live admission arithmetic the capacity gate needs. Supplied by the engine (it owns the aging
 * clock and the per-node "deferred since" memory); absent means the gate is OPEN, which is exactly
 * how the engine behaved before capacity existed and keeps `MissionTree.nextDispatchable()`'s
 * low-level contract unchanged.
 */
export interface CapacityPolicy {
  /** Master gate, in the same unit as `weight`. */
  readonly capacity: number
  /** Backstop on the NUMBER of running units (`maxConcurrent`). */
  readonly maxConcurrent: number
  readonly runningCount: number
  readonly runningWeight: number
  /** Node id → the time the capacity gate first deferred it. Drives aging; the engine owns it so a
   *  test can move the injected clock instead of waiting. */
  readonly deferredSince: ReadonlyMap<string, number>
  /** Wait past which a deferred node RESERVES the machine (no new admissions until it fits). */
  readonly agingMs: number
  readonly now: number
  /** A machine-wide gate (the free-memory floor) that blocks EVERY dispatch while set. */
  readonly globalBlock?: WaitingFor
}

/** One candidate the plan did not select, with the reason it is waiting. */
export interface DeferredCandidate {
  readonly node: NodeRecord
  readonly waitingFor: WaitingFor
}

/**
 * The machine-side half of the admission arithmetic: what the gate compares a candidate against.
 * Deliberately split from {@link CapacityPolicy}, which adds the caller's SNAPSHOT of the load, the
 * aging clock and the machine-wide block. The lock-held recheck takes these numbers as given but
 * FILLS THEM FROM LIVE STATE (`MissionTree.runningLoad()`), which is exactly why the shared judgement
 * cannot read the policy's snapshot itself.
 */
export interface CapacityLoad {
  /** Master gate, in the same unit as `weight`. */
  readonly capacity: number
  /** Backstop on the NUMBER of running units (`maxConcurrent`). */
  readonly maxConcurrent: number
  readonly runningCount: number
  readonly runningWeight: number
}

/**
 * The ONE capacity judgement, shared by {@link planDispatch} and by the tree's lock-held recheck so
 * the two can never drift: `undefined` when `node` may be admitted right now, otherwise the
 * structured reason it must wait.
 *
 * The rule: a candidate heavier than the whole machine (`weight > capacity`) is EXCLUSIVE and fits
 * only when nothing else is running — the arithmetic form of "it is the reservation that waited the
 * longest"; otherwise `Σ running.weight + weight ≤ capacity`. In both cases the `maxConcurrent` slot
 * ceiling must have room. The reason keeps the projection's long-standing precedence: capacity
 * (the master gate) before the slot ceiling.
 */
export function capacityWaitingFor(node: NodeRecord, load: CapacityLoad): WaitingFor | undefined {
  const weight = normalizeWeight(node.weight)
  const fits = weight > load.capacity
    ? load.runningCount === 0
    : load.runningWeight + weight <= load.capacity
  const slotsFree = load.runningCount < load.maxConcurrent
  if (fits && slotsFree) return undefined
  if (load.runningWeight + weight > load.capacity) {
    return {
      reason: 'capacity',
      resource: 'cpu',
      needed: weight,
      available: Math.max(0, load.capacity - load.runningWeight),
    }
  }
  return {
    reason: 'slot',
    needed: 1,
    available: Math.max(0, load.maxConcurrent - load.runningCount),
  }
}

/** What one admission scan resolved to. */
export interface DispatchPlan {
  readonly selected: NodeRecord | undefined
  /** Every candidate examined and left behind, in FIFO order, with its live waiting reason. */
  readonly deferred: readonly DeferredCandidate[]
  /**
   * True when an aged node has RESERVED the machine and does not fit yet: the caller must not admit
   * anything else this pass. `selected` is then `undefined` by construction.
   */
  readonly reserved: boolean
}

/** What {@link selectNextDispatchable} needs to know beyond the node states themselves. */
export interface DispatchPolicy {
  /** Node ids already spoken for in this pass; they must not be selected twice. */
  readonly exclude?: ReadonlySet<string>
  readonly now: number
  readonly isAgentLive: (sessionId: string) => boolean
  /** Capacity/slot admission arithmetic; absent means "no capacity gate" (the legacy contract). */
  readonly capacity?: CapacityPolicy
}

/**
 * The next node to dispatch, or `undefined`. Kept as the simple projection of {@link planDispatch}
 * for callers that only need the answer (and for the pre-capacity contract).
 */
export function selectNextDispatchable(
  scopes: Iterable<DispatchScope>,
  policy: DispatchPolicy,
): NodeRecord | undefined {
  return planDispatch(scopes, policy).selected
}

/**
 * The full admission scan: pick at most one node to dispatch AND describe every candidate left
 * behind. Selection rules, in order:
 *
 * 1. Collect the eligible candidates exactly as the pre-capacity engine did (open tree, live owner,
 *    not excluded, dispatchable, no live binding, no parked session, no held unit, not in spawn
 *    backoff), FIFO by {@link byCreatedAtThenId}.
 * 2. A machine-wide block (the free-memory floor) defers everything, nothing ages, no reservation.
 * 3. The slot ceiling, if reached, defers everything (capacity may still have room).
 * 4. An AGED candidate (waiting for capacity at least `agingMs`) that is not unit-blocked takes the
 *    machine: if it fits — or it is heavier than the whole capacity and nothing is running — it is
 *    selected; otherwise `reserved` is true and nothing else is admitted.
 * 5. Otherwise the first FITTING candidate in FIFO order is selected, skipping heavier ones, so
 *    spare capacity is filled (work-conserving).
 */
export function planDispatch(
  scopes: Iterable<DispatchScope>,
  policy: DispatchPolicy,
): DispatchPlan {
  const all = [...scopes]
  const held = heldUnits(all)
  const exclude = policy.exclude ?? new Set<string>()
  const gate = policy.capacity

  const candidates: NodeRecord[] = []
  const unitBlocked: DeferredCandidate[] = []
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
      // Cooling down after a failed START: `claimedAt` is that dispatch's time, so the backoff
      // is waited out rather than re-failing on every pump until the budget burns. A cooldown is
      // not a resource wait, so it carries no `waitingFor`.
      if (node.spawnFailures > 0 && policy.now - node.claimedAt < spawnBackoffMs(node.spawnFailures)) continue
      // Another `running` node owns this unit: at most one executor per scope, so the candidate
      // waits for the holder to leave `running` (it always does; see the module comment). Reported
      // so the panel can say WHAT it is waiting for, but it never reserves the machine: the holder
      // always leaves on its own and blocking admissions on it would idle everything.
      if (node.unit != null && held.has(node.unit)) {
        unitBlocked.push({ node, waitingFor: { reason: 'unit', unit: node.unit } })
        continue
      }
      candidates.push(node)
    }
  }
  candidates.sort(byCreatedAtThenId)

  // No capacity gate: the legacy answer, first candidate in FIFO order. The unit-blocked entries are
  // still described, because the projection exists independently of whether the gate is armed.
  if (gate === undefined) {
    return { selected: candidates[0], deferred: unitBlocked, reserved: false }
  }

  // The shared judgement describes a candidate left behind; a candidate that DOES fit is still
  // described with the slot reason the projection has always used (it was skipped for another
  // candidate, a reservation, or the one-dispatch-per-pass rule), hence the fallback.
  const describe = (node: NodeRecord): WaitingFor => capacityWaitingFor(node, gate) ?? {
    reason: 'slot',
    needed: 1,
    available: Math.max(0, gate.maxConcurrent - gate.runningCount),
  }

  // A machine-wide block defers everything and ages nothing: the memory floor is not the node's
  // wait, and charging it to a node would reserve the machine on a node that never became heavy.
  if (gate.globalBlock !== undefined) {
    const deferred = [
      ...unitBlocked,
      ...candidates.map((node) => ({ node, waitingFor: gate.globalBlock as WaitingFor })),
    ]
    return { selected: undefined, deferred, reserved: false }
  }

  // The SAME judgement the lock-held recheck runs (`MissionTree.capacityRefusal`): a candidate is
  // admissible exactly while the shared gate says it is. `maxConcurrent` is already folded in.
  const admissible = (node: NodeRecord): boolean => capacityWaitingFor(node, gate) === undefined

  // Step 4: an AGED node takes the machine.
  const aged = candidates
    .filter((node) => {
      const since = gate.deferredSince.get(node.id)
      if (since === undefined) return false
      if (policy.now - since < gate.agingMs) return false
      // A node blocked by a unit lease is not a capacity reservation (see `unitBlocked`).
      return gate.runningWeight + normalizeWeight(node.weight) > gate.capacity
    })
    .sort((a, b) => {
      const sa = gate.deferredSince.get(a.id) ?? 0
      const sb = gate.deferredSince.get(b.id) ?? 0
      return sa !== sb ? sa - sb : byCreatedAtThenId(a, b)
    })
  if (aged.length > 0) {
    const reserved = aged[0] as NodeRecord
    if (admissible(reserved)) {
      const deferred = [
        ...unitBlocked,
        ...candidates
          .filter((node) => node.id !== reserved.id)
          .map((node) => ({ node, waitingFor: describe(node) })),
      ]
      return { selected: reserved, deferred, reserved: false }
    }
    const deferred = [
      ...unitBlocked,
      ...candidates.map((node) => ({ node, waitingFor: describe(node) })),
    ]
    return { selected: undefined, deferred, reserved: true }
  }

  // Step 5: work-conserving first-fit.
  const selected = candidates.find(admissible)
  const deferred = [
    ...unitBlocked,
    ...candidates
      .filter((node) => node.id !== selected?.id)
      .map((node) => ({ node, waitingFor: describe(node) })),
  ]
  return { selected, deferred, reserved: false }
}
