/**
 * Content addressing for DERIVED data (DESIGN §20).
 *
 * Both stores keep expensive derivations next to their source text: the entity rows and the
 * embedding vector of a chunk, the vector of a fact. Rebuilding them is the expensive part of
 * ingest/reindex (an ONNX forward pass per row), so "is this derivation still valid?" must be
 * answerable without redoing it.
 *
 * The digest is over the CONTENT only — never over a timestamp, a path, or the row's own
 * metadata. A re-ingest that reproduces the same text must hash the same, or every rewrite
 * would look like a change and re-encode the world.
 *
 * WHAT IT DOES NOT CATCH TODAY, so nobody mistakes it for the main signal: `ingest` always
 * replaces a document's chunks (delete + insert) rather than updating `doc_chunks.text` in
 * place, so a re-ingested change arrives as a NEW row — caught by `has_vector = 0`. The hash
 * therefore only fires for a text mutation made outside that path: a hand-applied SQL fix, or a
 * future in-place edit. That is a real guard (the alternative is silently serving a vector for
 * text that no longer exists) and it is cheap next to an ONNX pass, but it is NOT what makes
 * `reindex` incremental — `embedding_model` and `entities_version` are.
 */
import { createHash } from 'node:crypto'

/** Stable content digest (sha1: change detection, not security). */
export function contentHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}
