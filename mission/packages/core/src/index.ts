/**
 * @avantf/mission-core — the mission-tree model, dispatch loop and prompt construction; harness environment facts arrive as injected dependencies.
 * @module @avantf/mission-core
 */
export * from './types.js'
export { MissionTree, defaultNewId } from './tree.js'
export type {
  TreeState,
  TreeStore,
  TreeDeps,
  SpilledText,
  CreateRootInput,
  DispatchDecision,
  OwnerProbe,
  OrphanedTree,
} from './tree.js'
export { MissionEngine, DEFAULT_ENGINE_OPTIONS, detectConcurrency } from './engine.js'
export type { EngineHooks, EngineOptions, StartWorkerInput, StallReport } from './engine.js'
export { buildWorkerPrompt, buildProgressLine, isTroubled, isTroubledNode, spillPointer, statusLabel } from './prompt.js'
