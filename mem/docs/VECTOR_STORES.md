# Vector stores

`avantf-mem` resolves its vector backend through the pluggable `retrieval-core` registry
(`config.vectorStore.backend` — camelCase, matching the zod config schema). See the table below for activation.

| backend | status | how to activate |
|---|---|---|
| `local_numpy` | ✅ default, brute-force | none (always available) |
| `hnswlib` | ✅ real ANN (cosine) | `vectorStore.backend: hnswlib` — `hnswlib-node` ships as an **optionalDependency** (native build; auto degrades to `local_numpy` if the binding misbehaves, rebuilding the fallback with ALL vectors) |
| `faiss` | 🟡 adapter surface (numpy alias) | install `faiss-node` (`pnpm add faiss-node`) and implement the `VectorStore` → replace the `faiss` registry entry |
| `pgvector` | 🟡 adapter surface | install `pg` + `pgvector`, provide a `DATABASE_URL`; implement the `VectorStore` |
| `qdrant` | 🟡 adapter surface | install `@qdrant/js-client-rest`, provide a Qdrant server; implement the `VectorStore` |
| `auto` | ✅ monotonic upgrade (`local_numpy` → `hnswlib`) | default; upgrades in-process once the live vector count crosses `vectorStore.auto_thresholds.hnswlib` (only when the native binding loads; never downgrades) |

## Why `faiss` / `pgvector` / `qdrant` are "adapter surfaces"

The pluggable design intentionally keeps the interface (`VectorStore`) and registry
(`registerVectorStore`) first-class; the concrete adapters for `faiss` / `pgvector` /
`qdrant` require their native or service dependencies, which are not installed by
default (they are cloud/service or heavy native libs). Until a real adapter is registered for
one of them, `config.vectorStore.backend` set to that name resolves to `local_numpy` (with an
explicit warning) so the system always missions.

## Activating a backend

```ts
import { registerVectorStore } from '@avantf/mem-core'

registerVectorStore('my_backend', () => new MyVectorStore(512))
```

then set

```yaml
# ~/.avantf/configs/common.yaml
vectorStore:
  backend: my_backend
```

Swapping a backend does **not** touch the business flow — stores, tools, and the
cross-retrieval router only ever use the `VectorStore` interface.

## Persistence

- All indexes are **derived read models**: the authoritative vectors live in the DB
  (`facts.semantic_vector` / `doc_chunks.semantic_vector`).
- On restart, BOTH stores rebuild their vstore from the persisted vectors during
  construction (memory: `MemoryStore.reloadIndex`, knowledge: `KnowledgeStore.reloadIndex`).
  The memory index holds **active facts only** — `archive` evicts the vector and
  `restore` re-adds it (archived rows are filtered out of every retrieval path).
  Vectors whose dim no longer matches `semantic.dim` are skipped with a warning and
  reported as `stale`; `avantf-mem vectors --fix` drops them so the current model can
  re-encode (needs the semantic backend), and `kb reindex` re-encodes chunk vectors.
- `admin vectors_fix` also repairs the live index without needing a model: it reloads
  persisted, dim-valid vectors missing from the index (`reindexed`) and encodes facts
  that never got a vector (`fixed`). Its report is
  `{missing, stale, unindexed, reindexed, dropped, fixed, semantic_available}` —
  `missing`/`unindexed` count ACTIVE facts only.
- Every automatic trust tick (startup, heartbeat, `maintenance`) returns the archived
  and purged fact ids and the store evicts them in one batch from the live index, so
  forgetting never leaves stale vectors behind. Physical purging is measured in
  **active days** (`archived_clock`), not calendar days.
