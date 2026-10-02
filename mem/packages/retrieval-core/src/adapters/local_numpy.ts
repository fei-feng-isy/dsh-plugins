import type { VectorStore } from '../interfaces.js'

/**
 * `local_numpy` — in-memory brute-force vector store.
 * Default / dev backend; persists via the caller (the store DB owns the vectors).
 * The fallback every backend without a real adapter resolves to; `hnswlib` is the implemented ANN
 * store, while `faiss`/`pgvector`/`qdrant` warn and land here.
 */
export class LocalNumpyVectorStore implements VectorStore {
  readonly name = 'local_numpy'
  readonly dim: number
  private readonly vectors = new Map<number, Float32Array>()

  constructor(dim: number) {
    this.dim = dim
  }

  add(id: number, vec: Float32Array): void {
    if (vec.length !== this.dim) throw new Error(`向量维度不匹配：得到 ${vec.length}，需要 ${this.dim}`)
    // Normalize so dot-product == cosine similarity.
    const norm = l2norm(vec)
    const out = new Float32Array(this.dim)
    for (let i = 0; i < this.dim; i++) out[i] = norm === 0 ? 0 : vec[i] / norm
    this.vectors.set(id, out)
  }

  topk(vec: Float32Array, k: number): { id: number; score: number }[] {
    const q = normalized(vec)
    const scored: { id: number; score: number }[] = []
    for (const [id, v] of this.vectors) {
      scored.push({ id, score: dot(q, v) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  fetch(ids: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>()
    for (const id of ids) {
      const v = this.vectors.get(id)
      if (v) out.set(id, v)
    }
    return out
  }

  remove(id: number): void {
    this.vectors.delete(id)
  }

  removeMany(ids: number[]): void {
    for (const id of ids) this.vectors.delete(id)
  }

  count(): number {
    return this.vectors.size
  }

  /** Iterate all stored (id, vector) pairs — used by `auto` to migrate to an ANN backend. */
  entries(): IterableIterator<[number, Float32Array]> {
    return this.vectors.entries()
  }

  rebuild(rows: Iterable<{ id: number; vec: Float32Array }>): void {
    this.vectors.clear()
    for (const r of rows) this.add(r.id, r.vec)
  }
}

function l2norm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum)
}

function normalized(v: Float32Array): Float32Array {
  const n = l2norm(v)
  if (n === 0) return v.slice()
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
