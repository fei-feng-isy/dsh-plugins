/**
 * The engine's public surface.
 *
 * Deliberately narrow, and deliberately explicit about what is NOT here. This used to be `export *`
 * over twenty modules, which published the database connection and schema, the migration list, the
 * HRR algebra, the entity extractor, the eval runner and the git wrapper to every consumer — none of
 * which any consumer used (the DSH plugin, the MCP server and the CLI import ten symbols between
 * them). A wide surface is not a harmless convenience: anything exported is a promise, and the
 * internals move (a DAO signature, a migration step, a tokenizer convention) on the assumption that
 * only the stores call them.
 *
 * Everything else is still importable BY MODULE PATH, which is what this package's own specs and the
 * `scripts/bench-*.mjs` benchmarks do — reaching into the engine is a choice a caller has to spell
 * out, rather than something the front door hands them.
 */
export * from './config/paths.js'
export * from './config/loader.js'
export * from './modelBootstrap.js'
export * from './dispatch.js'
export * from './trustHeartbeat.js'
export * from './runtime.js'
export * from './store/memory.js'
export * from './store/knowledge.js'
// The ONE write-side normalization (well-formed + NFC + the trim the stores apply), exported for
// callers that must compare fact CONTENT the same way the store does. The CLI's `merge` is the
// first such caller: its identity for "the same fact" must not become a second normalization that
// drifts from `MemoryStore.add`'s (see `store/common.ts`).
export { normalizeWrite } from './store/common.js'
// The machine-independent facts export/import document and the ONE content-identity import loop
// behind `avantf-mem import` and `avantf-mem merge`. It lives here, not in the CLI, because the
// plugin's `/mem` command must reach the same path without importing another tree's CLI (guard).
export * from './facts_io.js'
// The path boundary and atomic writer shared by the agent-callable maintenance actions. A tool
// parameter may only address the data root; this module is the ONE implementation of that rule.
export * from './maintenance_paths.js'
// The full-fidelity REBUILD path behind `avantf-mem restore` — the counterpart of the import loop
// above. Exported for the same reason: the CLI may spend argv and file IO, but the transaction, the
// empty-table rule and the report belong to the engine (and a later in-host surface must reach the
// SAME transaction, not a second copy of it).
export * from './store/facts_restore.js'
// The shared vector-space repair flow both stores run, and the driver the plugin mounts. Exported for
// the same reason as the retrieval orchestration below: it is the pluggability point for a THIRD
// store (write an adapter, do not copy the loop), and the plugin has to drive both stores through the
// one implementation.
export * from './store/vector_repair.js'
// The shared retrieval orchestration both stores run. Exported because `RetrievalInputError` crosses
// the boundary (a caller-supplied `queryVector` of the wrong width is rethrown rather than degraded,
// so a caller can tell its own mistake from a backend failure) — and because a third store built on
// the same legs should reuse the orchestration instead of copying it a third time.
export * from './store/hybrid.js'
export * from './store/source_picker.js'
export * from './store/lexical.js'
// The relevance floors the legs apply before fusion (`retriever.min_*`) — exported for the same
// reason as the orchestration: a third store built on these legs must read the SAME relaxation rule.
export * from './store/floors.js'
// The pluggability contract itself (DESIGN §5): the two registries' entry points plus the two
// interfaces they resolve to. Re-exported so the plugin's published face can hand them to a consumer
// WITHOUT naming `@avantf/mem-retrieval` (a private package that is not on npm) — the declarations are
// carried into the plugin tree by `scripts/carry-engine-types.mjs`. Registration and resolution must
// share one module instance, which is exactly why this re-export goes through the engine rather than a
// second import site: `buildRuntime` resolves through the same registry these mutate.
export {
  registerSemanticBackend,
  registerVectorStore,
  type SemanticBackend,
  type VectorStore,
} from '@avantf/mem-retrieval'
