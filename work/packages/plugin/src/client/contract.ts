/**
 * The client half's own vocabulary, declared here rather than imported from
 * `@avantf/work-core`: the browser bundle must not pull the host engine in.
 * @module @avantf/dsh-work/client/contract
 */

export interface WorkNodeView {
  readonly id: string
  /** Where the node was born; `children` is the dependency edge it is rendered by. */
  readonly parentId: string | null
  /** The ids this node depends on (a reused prerequisite appears in several parents). */
  readonly children: readonly string[]
  readonly depth: number
  readonly title: string
  /** Why this work exists (written by whoever decomposed its parent). */
  readonly context: readonly string[]
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  readonly hasResult: boolean
  readonly resultRef: string | null
}

export interface WorkTreeViewData {
  readonly rootId: string
  readonly nodes: readonly WorkNodeView[]
  /** Epoch millis when the owner archived the tree; `null` while it is live. */
  readonly closedAt: number | null
}

export interface WorkSnapshot {
  readonly trees: readonly WorkTreeViewData[]
}

export interface WorkSnapshotState {
  readonly data: WorkSnapshot | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly refresh: () => Promise<void>
}

export interface WorkNodeDetailView {
  readonly id: string
  readonly rootId: string
  readonly title: string
  readonly description: string
  readonly context: readonly string[]
  readonly status: string
  readonly attempts: number
  readonly depth: number
  /** The work's own submitted result, or null while it has not submitted one. */
  readonly result: string | null
  /** Where an oversized result was spilled, so the reader can still open it. */
  readonly resultPointer: string | null
}

export interface WorkNodeDetailChild {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly result: string | null
  readonly resultPointer: string | null
}

/** What a clicked row expands into. Read on demand, never part of the snapshot. */
export interface WorkNodeDetail {
  readonly node: WorkNodeDetailView
  readonly children: readonly WorkNodeDetailChild[]
}

export interface WorkViewProps {
  /** Read the current snapshot and keep it updated. */
  readonly useSnapshot: () => WorkSnapshotState
  /** Delete one whole finished work tree by root; rejects with the host's reason, which the view shows. */
  readonly onDeleteTree: (rootId: string) => Promise<void>
  readonly loadDetail: (nodeId: string) => Promise<WorkNodeDetail>
}
