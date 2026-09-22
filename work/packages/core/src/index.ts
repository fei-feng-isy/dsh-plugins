/**
 * @avantf/work-core — the work-tree model, dispatch loop and prompt construction; harness environment facts arrive as injected dependencies.
 * @module @avantf/work-core
 */
export * from './types.js'
export { WorkTree, defaultNewId } from './tree.js'
export type {
  TreeState,
  TreeStore,
  TreeDeps,
  SpilledText,
  CreateRootInput,
  DispatchDecision,
} from './tree.js'
export { WorkEngine, DEFAULT_ENGINE_OPTIONS, detectConcurrency } from './engine.js'
export type { EngineHooks, EngineOptions, StartWorkerInput, StallReport } from './engine.js'
export { buildWorkerPrompt, buildProgressLine, isTroubled, spillPointer, statusLabel } from './prompt.js'
