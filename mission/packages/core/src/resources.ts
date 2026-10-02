/**
 * `ResourceProbe` — the port through which the engine reads the machine, and the one place the
 * family's `null`-is-not-zero rule is stated. Node-free: the core declares the interface and never
 * implements it; the plugin/host supplies a probe built on `node:os` (see `host.ts`), which is also
 * the ONLY seam allowed to contain platform branches.
 *
 * ## `null` is a first-class answer: "no signal on this platform"
 *
 * **"No signal" ≠ "idle".** A `null` must never be read as evidence that resources are free, so it
 * may only ever make scheduling MORE conservative — never more permissive. Concretely:
 *
 * - `memoryBudget()` returning `null` while the free-memory floor is armed means "cannot confirm the
 *   floor", and the gate DEFERS dispatch. It is not "plenty of memory".
 * - `pressure()` returning `null` means "cannot tell"; no caller may treat it as `0` to widen
 *   concurrency or lower a weight. v1 has no pressure-driven widening at all, so the honest reading
 *   is "no adjustment".
 * - `workerUsage()` returning `null` means "this process's CPU is unknown"; it is not `0`, and v2's
 *   correction loop must treat it as "do not correct from this sample".
 *
 * The distinction between an OPTIONAL member that is absent and one that returns `null` is
 * deliberate: absent = this port has no implementation for that signal at all (the v1 degradation
 * path — no platform adapter), while `null` = implemented but the platform will not say. The former
 * leaves the corresponding gate inactive; the latter keeps the gate conservative.
 *
 * ## v1 scope
 *
 * Only the interface, the wiring, and a host implementation over the UNIFIED Node API
 * (`os.availableParallelism()`, `os.totalmem()`, `process.constrainedMemory()`, `os.freemem()`).
 * Platform adapters (POSIX/Windows `pressure`, per-worker process attribution) and measured
 * correction of weights are v2; every unimplemented branch answers `null`.
 *
 * @module @avantf/mission-core/resources
 */

/** One worker process's CPU sample, in the same 0..1-ish scale as {@link ResourceProbe.pressure}. */
export interface ResourceProbe {
  /**
   * How much independent work this machine will ACTUALLY run in parallel — i.e.
   * `os.availableParallelism()`, which honours cgroup CPU quotas and CPU affinity, rather than the
   * raw core count. Required, because every host can answer it: Node falls back to `os.cpus()`.
   */
  parallelism(): number
  /**
   * A LOWER BOUND, in bytes, on the memory this process may still use, or `null` when the platform
   * will not say. "Lower bound" is the whole contract: the value may understate what is available,
   * which is the safe direction for a floor gate, and it includes the cgroup cap when one exists
   * (a cgroup limit below `os.totalmem()` is the real budget). Never an exact figure, never "free
   * memory" in the leaving-room sense.
   */
  memoryBudget?(): number | null
  /**
   * A coarse 0..1 pressure reading (sustained CPU contention / memory pressure), or `null` when the
   * platform cannot produce one. v1 never widens from it; the member exists so v2's adapters and the
   * scheduler can be written against a stable signature.
   */
  pressure(): number | null
  /** CPU usage of one worker process, or `null` when this platform cannot attribute it (v2). */
  workerUsage?(pid: number): number | null
}
