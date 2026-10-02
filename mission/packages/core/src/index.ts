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
export type {
  EngineHooks,
  EngineOptions,
  ResumeOutcome,
  ResumeWorkerInput,
  StartWorkerInput,
  StallReport,
} from './engine.js'
export {
  byCreatedAtThenId,
  heldUnits,
  normalizeUnit,
  resolveChildUnit,
  selectNextDispatchable,
  spawnBackoffMs,
  unitHolder,
} from './dispatch.js'
export type { DispatchPolicy, DispatchScope } from './dispatch.js'
export { computeContinuationDelta, isMaterialChange, nodeFingerprint } from './continuation.js'
export type { ContinuationDelta } from './continuation.js'
export { buildWorkerPrompt, buildProgressLine, isTroubled, isTroubledNode, spillPointer, statusLabel } from './prompt.js'
export type { WorkerPromptOptions } from './prompt.js'
