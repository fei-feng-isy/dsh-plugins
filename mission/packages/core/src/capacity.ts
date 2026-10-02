/**
 * Capacity vocabulary: how much of ONE machine a mission may occupy, and how the machine's own
 * capacity is derived. Both are plain numbers, deliberately — this module never imports `node:os`
 * (the core builds without Node types) and never guesses at the hardware.
 *
 * ## The two numbers, and why they are not the same
 *
 * - **`weight`** is declared by a NODE: "this mission will occupy about N cores-equivalent while it
 *   runs". It defaults to 1, which is the ordinary slot every mission used to take.
 * - **`capacity`** is derived for the HOST: how many of those units may run at once on this machine.
 *
 * The engine admits a candidate only while `Σ running.weight + candidate.weight ≤ capacity`. That is
 * the master gate; `maxConcurrent` survives as a ceiling on the NUMBER of units (see `engine.ts`).
 * Both are injected into the core as numbers, so every scheduling decision is deterministic under
 * test; the machine reading itself happens at the plugin/host seam, in `resource.ts`'s probe.
 *
 * @module @avantf/mission-core/capacity
 */

/** Ceiling on derived capacity. 64 is far past any single machine this engine is meant to drive, and
 *  it keeps a wild reading (a container reporting 4096 CPUs) from materialising 4000 claims. */
export const CAPACITY_CEILING = 64

/** Parallelism assumed when the host cannot read the machine at all (chain step ④). */
export const CAPACITY_FALLBACK_PARALLELISM = 4

/** Cores left to the host/UI: one, matching this family's long-standing `cores - 1` convention. The
 *  engine itself, the owner's turns and the browser half all live on the same box. */
export const RESERVED_CORES = 1

/**
 * Where a capacity reading came from, in priority order. The literal is part of the start-up log
 * (`capacity=N (source=…)`) and is therefore observed by operators, not just by tests.
 */
export type CapacitySource = 'config' | 'availableParallelism' | 'cores' | 'default'

export interface CapacityInput {
  /** Step ①: the operator's explicit number. Used AS GIVEN (clamped), with no `-1` reservation:
   *  an explicit number is already the answer, and silently subtracting from it would make a
   *  configured 4 mean 3. */
  readonly configured?: number | null
  /** Step ②: `os.availableParallelism()` — respects cgroup quotas and CPU affinity. */
  readonly availableParallelism?: number | null
  /** Step ③: `os.cpus().length` — the physical/logical core count, ignoring quotas. */
  readonly cores?: number | null
}

export interface CapacityReading {
  /** The number the engine gates on. */
  readonly capacity: number
  readonly source: CapacitySource
  /** The raw parallelism the source reported, BEFORE the host reservation and the clamp. */
  readonly parallelism: number
  /** Cores withheld from the engine: 1 for a derived reading, 0 for an explicit configuration. */
  readonly reserved: number
}

/** A usable parallelism reading: a finite number ≥ 1, floored. Anything else is "no reading". */
function usable(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const floored = Math.floor(value)
  return floored >= 1 ? floored : undefined
}

/** Clamp one capacity into `[1, CAPACITY_CEILING]`; a non-number degrades to the floor. */
export function clampCapacity(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(CAPACITY_CEILING, Math.max(1, Math.floor(value)))
}

/**
 * The derivation chain, in ONE pure function so "which source won" is decided (and tested) in one
 * place:
 *
 * ① explicit config → ② `os.availableParallelism()` → ③ `os.cpus().length` → ④ 4,
 * then `capacity = clamp(max(1, derived - RESERVED_CORES), 1, CAPACITY_CEILING)`.
 *
 * Step ① is the exception to the reservation: an explicit number is used as-is (clamped). Measured
 * on the development host (2026-10-02): `availableParallelism` = 12 → capacity 11, `cpus().length`
 * = 12, cgroup `cpu.max` = `max 100000` (no quota).
 */
export function deriveCapacity(input: CapacityInput = {}): CapacityReading {
  const configured = usable(input.configured)
  if (configured !== undefined) {
    const capacity = clampCapacity(configured)
    return { capacity, source: 'config', parallelism: capacity, reserved: 0 }
  }
  const available = usable(input.availableParallelism)
  const cores = usable(input.cores)
  const parallelism = available ?? cores ?? CAPACITY_FALLBACK_PARALLELISM
  const source: CapacitySource = available !== undefined
    ? 'availableParallelism'
    : cores !== undefined
      ? 'cores'
      : 'default'
  const capacity = clampCapacity(Math.max(1, parallelism - RESERVED_CORES))
  return { capacity, source, parallelism, reserved: RESERVED_CORES }
}

// ── weight ──────────────────────────────────────────────────────────────────

/** The weight of a node that declares none: one ordinary slot. */
export const DEFAULT_WEIGHT = 1

/** Lowest meaningful weight: a mission that runs at all occupies at least one slot. */
export const MIN_WEIGHT = 1

/** Highest declared weight. Matches the capacity ceiling, so even a "give me the whole machine"
 *  declaration (`weight` far above any real capacity) clamps to a number the engine can compare
 *  without a special case; `weight > capacity` remains reachable on every real host. */
export const MAX_WEIGHT = 64

/**
 * Read a declared weight into range. Missing, dirty or non-numeric values read as
 * {@link DEFAULT_WEIGHT}, exactly like a record written before the field existed; a fractional value
 * floors; anything below 1 rises to 1 and anything above {@link MAX_WEIGHT} falls to it.
 *
 * This is the ONE normalizer: the tool layer, the persistence load path and `makeNode` all call it,
 * so a weight cannot mean two different things in two places.
 */
export function normalizeWeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_WEIGHT
  const floored = Math.floor(raw)
  if (floored < MIN_WEIGHT) return MIN_WEIGHT
  if (floored > MAX_WEIGHT) return MAX_WEIGHT
  return floored
}

// ── timing / memory defaults ────────────────────────────────────────────────

/**
 * How long a node may be repeatedly deferred by the capacity gate before it RESERVES the machine:
 * past this, no new node is admitted until the reserved one fits. Five minutes sits inside the
 * recommended 3–10 minute band for one reason on each side: shorter windows turn an ordinary burst
 * of weight-1 work into a reservation (which idles capacity the moment the heavy node cannot fit),
 * while longer windows let a heavy mission wait through a whole work cycle before the engine stops
 * feeding the queue in front of it.
 */
export const DEFAULT_CAPACITY_WAIT_MS = 5 * 60 * 1000

/** Floor on a configured aging window. Below a minute, a reservation is indistinguishable from a
 *  scheduling hiccup, and work-conserving filling would be defeated by normal jitter. */
export const MIN_CAPACITY_WAIT_MS = 60 * 1000

/**
 * Default free-memory floor. A worker session is a model call plus tooling; below ~256 MiB the
 * process is at real OOM risk. Deliberately low, because the host's floor signal is `os.freemem()`,
 * which is a COARSE lower bound (see the probe) and a high threshold would stall ordinary work.
 * `0` disables the gate.
 */
export const DEFAULT_MIN_FREE_MEMORY_BYTES = 256 * 1024 * 1024
