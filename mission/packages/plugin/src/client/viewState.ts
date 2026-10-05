/**
 * The 「任务」 view's REMOUNT-RESISTANT UI state.
 *
 * WHY THIS EXISTS. The host's `conversation.view` outlet keys every rendered entry by ENTRY IDENTITY
 * (`@deepseek-ai/dsh-client-ui-renderer`'s `entryKeyOf` — a per-entry `WeakMap` counter), never by the
 * `id` a plugin registered with. The tab's running marker keeps itself honest by re-registering its
 * seat whenever the verdict flips (see `client/index.ts`), which mints a NEW entry, so React unmounts
 * and remounts `MissionTreeView`. Without state that outlives the component, a mission starting (or
 * the last one finishing) would collapse the reader's expanded rows, close the open detail dialog and
 * jump the tree list back to the top — exactly the state the marker must not cost.
 *
 * SCOPE. One record per SESSION: `conversation.view` is a per-session slot, so two conversations must
 * not share a scroll offset or an open dialog.
 *
 * WHY A PLAIN MODULE MAP, NOT REACT STATE. Its entire purpose is to outlive the component instance,
 * so it cannot live inside one. It is deliberately small and bounded — a long-lived browser tab must
 * not accumulate one record per mission ever looked at. It is NOT a general store: only what a
 * remount would visibly destroy belongs here (an in-flight read, a confirm prompt or the dialog's
 * selected section are transient by nature and stay where they are).
 *
 * @module @avantf/dsh-mission/client/viewState
 */

/** What one session's view remembers across a remount. */
export interface MissionViewState {
  /** Scroll offset of the tree list, restored on the next mount. */
  scrollTop: number
  /** The node whose detail dialog is open, restored (and re-read) on the next mount. */
  openId?: string
  /** Per-node expand/collapse OVERRIDES; the default keeps tracking the node's own status. */
  readonly overrides: Map<string, boolean>
}

/** Sessions kept; least-recently-used first out. Every conversation a reader could plausibly have. */
const MAX_SESSIONS = 32

/** Row overrides kept per session; least-recently-used first out. */
const MAX_OVERRIDES = 512

const states = new Map<string, MissionViewState>()

/** The state for one session, created on first use and touched so the LRU order stays honest. */
export function viewStateFor(sessionId: string): MissionViewState {
  const existing = states.get(sessionId)
  if (existing !== undefined) {
    // Re-insert: Map iteration order is insertion order, so the first key is the coldest.
    states.delete(sessionId)
    states.set(sessionId, existing)
    return existing
  }
  const created: MissionViewState = { scrollTop: 0, overrides: new Map() }
  states.set(sessionId, created)
  if (states.size > MAX_SESSIONS) {
    const coldest = states.keys().next()
    if (!coldest.done) states.delete(coldest.value)
  }
  return created
}

/**
 * Remember one row's expand/collapse override. Only the FACT that the reader clicked is stored (the
 * default keeps following the node's status), and the oldest key is evicted at the bound so a long
 * session cannot grow this forever.
 */
export function rememberOverride(state: MissionViewState, nodeId: string, expanded: boolean): void {
  state.overrides.delete(nodeId)
  state.overrides.set(nodeId, expanded)
  if (state.overrides.size > MAX_OVERRIDES) {
    const coldest = state.overrides.keys().next()
    if (!coldest.done) state.overrides.delete(coldest.value)
  }
}
