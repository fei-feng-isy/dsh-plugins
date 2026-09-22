/**
 * Process-wide logger seam for the retrieval core. The DSH plugin installs the
 * host logger through {@link setRetrievalLogger}; standalone runs (CLI / MCP /
 * tests) keep the prefixed console default. The core deliberately has no Cordis
 * dependency, so a module seam is the only way to reach every adapter.
 */
import { defaultLogger, type AvantfLogger } from '@avantf/mem-contract'

let active: AvantfLogger = defaultLogger

/** Route retrieval-core logs (model warm / degrade) to a host logger. */
export function setRetrievalLogger(logger?: AvantfLogger): void {
  active = logger ?? defaultLogger
}

/** The logger every adapter reports through. */
export function retrievalLogger(): AvantfLogger {
  return active
}
