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
export * from './runtime.js'
export * from './store/memory.js'
export * from './store/knowledge.js'
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
