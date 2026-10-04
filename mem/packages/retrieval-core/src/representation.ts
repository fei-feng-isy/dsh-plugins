/**
 * The REPRESENTATION fingerprint: which coordinates a persisted vector lives in.
 *
 * `vectorSpaceId` used to record only `backend/model/dim`, so the identity was blind to everything
 * else that changes what an embedding IS — pooling, normalization, the truncation window, and the
 * weights behind an unchanged repo name. All four produced byte-comparable-looking vectors that
 * rank in different coordinates, with no detection anywhere (the gap DESIGN §20 now names as a
 * rule). This module owns the two halves of closing that gap:
 *
 *  - {@link representationKey} — the normalized, stable string the space id embeds, so ANY of the
 *    knobs moving makes the id differ and the migration is triggered;
 *  - {@link readModelRevision} — best-effort read of the family framework's model sidecar, so
 *    "the same repo name now points at different weights" is detectable too. A sidecar that is
 *    missing or malformed DEGRADES (no revision in the fingerprint) and never throws: the whole
 *    point is to fail toward "less detection", never toward "cannot open the store".
 *
 * The sidecar layout is deliberately mirrored from `@avantf/dsh-plugin-base`
 * (`providers/model.ts`: `<cacheDir>/.envinit/models--<owner>--<name>/record.json`), not imported:
 * `@avantf/mem` never imports the base (AGENTS.md, «the three family hard constraints»), and this
 * package is inlined into an artifact whose base may be absent. The mirror is narrow — one
 * directory name and one file name — and the base's own tests own the writer.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandHome } from '@avantf/mem-contract'
import type { SemanticBackend, SemanticRepresentation } from './interfaces.js'

/** The base's sidecar directory for provisioned model caches. */
const MODEL_SIDECAR_DIR = '.envinit'
/** The base's per-model record file (`{repo, revision, sha, files, digests}`). */
const MODEL_RECORD_FILE = 'record.json'

/** The declared representation of a backend that does not implement `representation()`. */
export const UNDECLARED_REPRESENTATION = 'rep=undeclared'

/** What {@link readModelRevision} found (or why it found nothing). */
export interface ModelRevisionRead {
  /** The model's content identity when the sidecar recorded one. */
  readonly revision?: string
  /** Where it was looked for (the degradation warning names it). */
  readonly path: string
  /** Why the revision is absent — short, for the one-line degradation warning. */
  readonly detail: string
}

/**
 * Normalized, stable representation key embedded in a vector-space id.
 *
 * Field order is fixed and each value is normalized (lowercased pooling, 1/0 normalize, a
 * truncated non-negative integer window), so two runs that describe the SAME representation always
 * produce the SAME key — a fingerprint that changed spuriously would re-encode a whole corpus for
 * nothing. A blank/absent revision is OMITTED rather than encoded as a placeholder: "unknown" then
 * looks different from any known revision, which is the honest reading (the weights could have
 * changed without this process being able to tell).
 */
export function representationKey(rep: SemanticRepresentation): string {
  const pooling = rep.pooling.trim().toLowerCase()
  const parts = [
    `p=${pooling === '' ? 'unset' : pooling}`,
    `n=${rep.normalize ? '1' : '0'}`,
    `w=${String(Math.max(0, Math.trunc(rep.maxInputTokens)))}`,
  ]
  const revision = rep.revision?.trim() ?? ''
  if (revision !== '') parts.push(`r=${revision}`)
  return parts.join(';')
}

/** {@link representationKey} for a live backend, or the explicit "undeclared" marker. */
export function representationKeyOf(backend: SemanticBackend): string {
  const declared = backend.representation?.()
  return declared === undefined ? UNDECLARED_REPRESENTATION : representationKey(declared)
}

/** The sidecar path for `model` under `cacheDir`, mirroring the base's flat-layout naming
 * (`models--<owner>--<name>`), which is why a slash in the repo id becomes `--`.
 */
export function modelRecordPath(cacheDir: string, model: string): string {
  const name = `models--${model.replaceAll('\\', '/').replaceAll('/', '--')}`
  return join(expandHome(cacheDir), MODEL_SIDECAR_DIR, name, MODEL_RECORD_FILE)
}

/**
 * Whether the model's weights are actually on disk in the flat layout the adapter reads
 * (`<cacheDir>/<repo>/config.json`).
 *
 * Only used to decide whether a missing revision is worth a WARNING: a machine that has never
 * installed the model (a fresh install still in flight) has nothing to fingerprint yet, so the
 * degradation is real but not yet reportable — warning there would be noise on every first run.
 * Once the weights are present and the sidecar still is not, "no revision" is a genuine blind spot.
 */
export function modelFilesPresent(cacheDir: string, model: string): boolean {
  const parts = model.replaceAll('\\', '/').split('/')
  return existsSync(join(expandHome(cacheDir), ...parts, 'config.json'))
}

/** A revision is usable when it is a non-empty string; anything else is "not recorded". */
function revisionOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const value = (record as Record<string, unknown>)['sha'] ?? (record as Record<string, unknown>)['revision']
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read the family sidecar's revision for `model`, never throwing.
 *
 * Absence is a legitimate state (a model fetched by transformers.js directly, a machine that never
 * ran the family provisioner, an install still in flight), not an error: the caller reports the
 * degradation once and the fingerprint simply omits the revision.
 *
 * @param cacheDir - the model cache root the adapter actually reads (`semantic.cache_dir`).
 * @param model - the repo id (`Xenova/bge-base-zh-v1.5`).
 */
export function readModelRevision(cacheDir: string, model: string): ModelRevisionRead {
  const path = modelRecordPath(cacheDir, model)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return { path, detail: code === 'ENOENT' ? `no sidecar at ${path}` : `cannot read ${path} (${String(code ?? 'error')})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { path, detail: `unparseable sidecar at ${path}` }
  }
  const revision = revisionOf(parsed)
  return revision === undefined
    ? { path, detail: `sidecar at ${path} records no revision` }
    : { revision, path, detail: `revision ${revision}` }
}
