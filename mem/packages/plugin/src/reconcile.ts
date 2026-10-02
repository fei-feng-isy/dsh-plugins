/**
 * Corpus reconciliation: the throttled "did anything under `knowledge.docs.dir` change?" sweep behind
 * `tools/result`.
 *
 * WHY IT IS ITS OWN MODULE. The plugin reaches the corpus through tool calls, so a finished tool call
 * is the moment to ask the question — and the answer is cheap (`corpusDrift()` is one `stat` per
 * document, reading nothing), which is what makes it affordable after EVERY tool result. Two things
 * about it are easy to get wrong and are pinned by `test/reconcile.spec.ts` instead of by a mounted
 * plugin: the THROTTLE (with a trailing run — skipping alone would drop the LAST edit, the one that
 * matters) and the STOP rule (an in-flight pass must not keep writing after the plugin unmounted and
 * its databases closed). `index.ts` is the assembly hub; this is the rule.
 *
 * @module @avantf/dsh-mem/reconcile
 */

/** The corpus surface a reconciler drives — structural, so a test can hand it a fake. */
export interface ReconcileCorpus {
  /** Re-ingest changed documents; `{}` is the full sweep that also reports corpus-level changes. */
  sync(options: { docId?: number }): Promise<unknown>
  /** One `stat` per document; no file is read. */
  corpusDrift(): { changed: number[]; missing: number[]; fileSetChanged: boolean }
}

/** What {@link createCorpusReconciler} needs from its caller. */
export interface ReconcileDeps {
  corpus: ReconcileCorpus
  /** Minimum spacing between non-full checks (ms). */
  minIntervalMs: number
  /** Called for a failed pass. The reconciler NEVER rethrows: a sync failure must not break the host. */
  onError(error: unknown): void
  /** Clock seam (defaults to `Date.now`). */
  now?(): number
  /** Timer seam (defaults to the global `setTimeout`); the handle is `unref`ed when it supports it. */
  schedule?(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  /** Timer-cancellation seam (defaults to the global `clearTimeout`). */
  cancel?(handle: ReturnType<typeof setTimeout>): void
}

/** The handle `index.ts` wires into an effect: request a check, and stop it on unmount. */
export interface CorpusReconciler {
  /** Run one check — `full` bypasses the throttle and takes the baseline after the sweep. */
  request(full: boolean): Promise<void>
  /**
   * Stop permanently: no further pass starts, a scheduled trailing check is cancelled, and a pass
   * already in flight exits at its next `await` boundary without touching the corpus again.
   */
  stop(): void
  /** Whether a pass is currently in flight (diagnostics and the unmount test). */
  readonly running: boolean
}

/**
 * Build the reconciler. All state is closed over here, so a fresh mount gets a fresh one — the
 * plugin can be unmounted and mounted again in one process.
 */
export function createCorpusReconciler(deps: ReconcileDeps): CorpusReconciler {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle) => { clearTimeout(handle) })
  let stopped = false
  let running = false
  let lastDriftAt = 0
  let trailing: ReturnType<typeof setTimeout> | null = null

  const request = async (full: boolean): Promise<void> => {
    if (stopped) return
    if (running) return
    if (!full) {
      const wait = deps.minIntervalMs - (now() - lastDriftAt)
      if (wait > 0) {
        if (trailing === null) {
          trailing = schedule(() => { trailing = null; void request(false) }, wait)
          // Not a reason for the process to stay alive: nothing promises the check runs.
          const unref = (trailing as unknown as { unref?: () => void }).unref
          if (typeof unref === 'function') unref.call(trailing)
        }
        return
      }
      lastDriftAt = now()
    }
    running = true
    try {
      if (full) {
        await deps.corpus.sync({})
        // THE STOP CHECK IS PER AWAIT, NOT PER PASS. `stop()` may land while the sweep above is in
        // flight (the unmount effect closes the databases right after): re-check before touching the
        // corpus again, so an unloaded plugin performs no further work.
        if (stopped) return
        // Take the baseline AFTER the sync: seeding it before would hide an edit that landed in
        // between, which is the one window this whole mechanism exists to close.
        deps.corpus.corpusDrift()
        return
      }
      const drift = deps.corpus.corpusDrift()
      if (drift.changed.length === 0 && drift.missing.length === 0 && !drift.fileSetChanged) return
      if (drift.fileSetChanged || drift.missing.length > 0) {
        // A new, vanished or frontmatter-destroyed `.md` is a corpus-level question (orphan /
        // missing), not a doc-level one — so escalate to the full reconcile, which is the surface
        // that reports it honestly instead of silently leaving the document un-ingested.
        await deps.corpus.sync({})
        if (stopped) return
        return
      }
      for (const docId of drift.changed) {
        await deps.corpus.sync({ docId })
        // Leave before the NEXT document when a stop landed during this one. This loop is the
        // bounded-cost half of the sweep (one sync per changed file), and it is exactly where an
        // unmount used to keep writing after `shutdown()`.
        if (stopped) return
      }
    } catch (error) {
      deps.onError(error)
    } finally {
      running = false
    }
  }

  return {
    request,
    stop() {
      stopped = true
      if (trailing !== null) {
        cancel(trailing)
        trailing = null
      }
    },
    get running() {
      return running
    },
  }
}
