/**
 * `unknown` → one readable line, for every log line that reports a failure.
 *
 * A LEAF MODULE on purpose. `gateway.ts`, `index.ts`, `presets.ts` and `state.ts` each carried their
 * own byte-identical copy of these three lines; four copies of one expression is not a contract, it
 * is sediment, and the next person to change how an error reads would have had to find all four.
 *
 * `interface_gate.ts` deliberately keeps ITS own copy: that file is the family's byte-identical shim
 * (pinned by `base/plugin-base/test/interface_consumers.spec.ts` across all three plugin trees), so a
 * relative import there would have to resolve inside every tree — i.e. it would need a `reason.ts`
 * per tree, which is more duplication, not less. The shim's copy is part of that pinned text.
 *
 * @module @avantf/dsh-identity/reason
 */

/** The message of an `Error`, or `String()` of anything else. Never throws, never returns `''`. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
