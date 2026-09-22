/**
 * The durable sink for trees: read everything on open, write one document per mutation,
 * remove a document when its tree is destroyed. The domain handle is created by the plugin
 * (a domain name can only be opened once per process) and passed in.
 * @module @avantf/dsh-work/store
 */
import type { TreeState, TreeStore } from '@avantf/work-core'
import type { TreeDocument } from './domain.js'
import { TREES_TABLE } from './domain.js'

/** The slice of the opened domain this store uses. */
export interface TreesTable {
  get(key: string): TreeDocument | undefined
  entries(): IterableIterator<[string, TreeDocument]>
  put(key: string, value: TreeDocument): Promise<void>
  delete(key: string): Promise<boolean>
  readonly size: number
}

export function createTreeStore(table: TreesTable): TreeStore {
  return {
    async loadAll(): Promise<TreeState[]> {
      const states: TreeState[] = []
      for (const [, document] of table.entries()) {
        states.push(toState(document))
      }
      return states
    },

    async put(state: TreeState): Promise<void> {
      await table.put(state.tree.rootId, toDocument(state))
    },

    async remove(rootId: string): Promise<void> {
      await table.delete(rootId)
    },
  }
}

export function toDocument(state: TreeState): TreeDocument {
  return { tree: state.tree, nodes: Object.fromEntries(state.nodes) }
}

export function toState(document: TreeDocument): TreeState {
  return { tree: document.tree, nodes: new Map(Object.entries(document.nodes)) }
}

/** The table name, re-exported so callers do not repeat the literal. */
export { TREES_TABLE }
