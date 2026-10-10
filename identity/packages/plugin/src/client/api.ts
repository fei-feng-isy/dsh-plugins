/**
 * The browser half's view of the host Remote face.
 *
 * Declared structurally, not imported: no installed dsh ships a `ui-slots` / `ui-settings` package the
 * plugin can type against (the browser shell seeds them into the module table), and importing one
 * would add a peer this plugin does not need. These are the shapes `src/wire.ts` declares on the wire;
 * the host's `strict` codec drops anything it does not name, so a field missing here shows up as a
 * missing field, not as a crash.
 *
 * @module @avantf/dsh-identity/client/api
 */

/** One identity file's status (no text). */
export interface FileStatus {
  readonly name: string
  readonly file: string
  readonly path: string
  readonly present: boolean
  readonly bytes: number
}

/** One identity file with its text. */
export interface FileText {
  readonly name: string
  readonly file: string
  readonly text: string
  readonly present: boolean
  readonly bytes: number
}

export interface PresetSummary {
  readonly id: string
  readonly locales: readonly string[]
  readonly active: boolean
}

/** The header's one call. */
export interface StatusView {
  readonly enabled: boolean
  readonly profile: string
  readonly dataHome: string
  readonly identityDir: string
  readonly presetsDir: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxBytes: number
  readonly interpolate: boolean
  readonly replaceScope: string
  readonly drop: readonly string[]
  readonly fallbackToNative: boolean
  readonly activePreset: string
  readonly activeLocale: string
  readonly locale: string
  readonly localeSource: string
  readonly files: readonly FileStatus[]
  readonly presets: readonly PresetSummary[]
}

export interface ProfileView {
  readonly profile: string
  readonly identityDir: string
  readonly totalBytes: number
  readonly files: readonly FileText[]
}

export interface PresetView {
  readonly found: boolean
  readonly id: string
  readonly requestedLocale: string
  readonly resolvedLocale: string
  readonly fellBack: boolean
  readonly files: readonly FileText[]
}

export interface WriteResult {
  readonly ok: boolean
  readonly error?: string
  readonly resolvedLocale?: string
  readonly fellBack?: boolean
  readonly files?: readonly string[]
}

/** The host's `avantfIdentity` namespace, as the page calls it. */
export interface IdentityRemote {
  status(args: { locale?: string }): Promise<StatusView>
  /** No parameters on the wire: the host method takes none (see `directNoArgs` in `wire.ts`). */
  listPresets(): Promise<{ readonly presets: readonly PresetSummary[] }>
  /** No parameters on the wire: the host method takes none (see `directNoArgs` in `wire.ts`). */
  readProfile(): Promise<ProfileView>
  writeProfileFile(args: { name: string; text: string }): Promise<WriteResult>
  applyPreset(args: { id: string; locale?: string }): Promise<WriteResult>
  saveAsPreset(args: { id: string; locale?: string }): Promise<WriteResult>
  readPreset(args: { id: string; locale?: string }): Promise<PresetView>
  writePresetFile(args: { id: string; name: string; text: string; locale?: string }): Promise<WriteResult>
  deletePreset(args: { id: string }): Promise<WriteResult>
}

/**
 * The slice of `ctx.configForms` this page uses.
 *
 * Read through `ctx.get('configForms')` at USE time rather than declared in the client plugin's
 * `inject`: a composition that never loaded the settings domain must still register the page (it says
 * "the switch is unavailable" instead of leaving a pending entry and failing the boot audit).
 */
export interface ConfigFormLike {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

export interface ConfigFormSnapshot {
  readonly value?: {
    readonly enabled?: boolean
    readonly activePreset?: string
    readonly activeLocale?: string
  }
}

/**
 * The settings domain SERVICE, which is what `ctx.get('configForms')` returns.
 *
 * The service is not a form: `getSnapshot`/`subscribe`/`set` live on `service.get(entryId)`, keyed by the
 * PROFILE ROW id. Reading the service as if it were a form throws `next.subscribe is not a function`
 * inside the page's effect — and a throw in an effect makes React tear the subtree down, so the settings
 * pane goes blank while its nav entry (rendered from `label`) stays. That is measured behaviour in a real
 * browser, not a hypothetical, which is why the hop below exists and is guarded.
 */
export interface ConfigFormsLike {
  get(entryId: string): ConfigFormLike | undefined
}

/**
 * Resolve one profile entry's config form out of the settings domain service.
 *
 * Deliberately total: an absent service, a service with no `get`, a `get` that throws, or a `get` that
 * answers something without `subscribe` all return `undefined`, so the page reports "the settings form is
 * not ready" instead of throwing inside an effect and blanking the pane.
 *
 * @param service - whatever `ctx.get('configForms')` answered.
 * @param entryId - the profile row id, which is also the settings namespace.
 * @returns the entry's form, or undefined when this deployment cannot supply one.
 */
export function resolveConfigForm(service: unknown, entryId: string): ConfigFormLike | undefined {
  const forms = service as ConfigFormsLike | undefined
  if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
  try {
    const form = forms.get(entryId)
    return typeof form?.subscribe === 'function' && typeof form.getSnapshot === 'function' ? form : undefined
  } catch {
    return undefined
  }
}

/** The fields the page may edit through the config form. */
export type ConfigField = 'enabled' | 'activePreset' | 'activeLocale'

/**
 * The Remote methods this page calls, in the order the wire face declares them.
 *
 * Kept as a list because the transport ENVELOPE has to be peeled per call (see {@link wrapRemote}),
 * and a wrapper that names the methods explicitly cannot silently miss a new one: the compatibility
 * gate already pins this exact set on the host side.
 */
export const REMOTE_METHODS = [
  'status',
  'listPresets',
  'readProfile',
  'writeProfileFile',
  'applyPreset',
  'saveAsPreset',
  'readPreset',
  'writePresetFile',
  'deletePreset',
] as const

/** A transport failure, so the page's own `catch` shows the host's reason. */
export class RemoteCallError extends Error {}

/**
 * Peel the TRANSPORT envelope, exactly once.
 *
 * The Remote proxy does not answer the host's return value; it answers `{ ok, value }` around it —
 * measured in the browser, where the page received `ok, value` and nothing else, so `status.drop` was
 * `undefined` and the render threw. Exactly ONE layer is peeled on purpose: this plugin's own write
 * results (`WriteResult`) carry an `ok` of their own, and a generic two-layer unwrap would eat that
 * and lose `error`/`files`.
 *
 * A bare payload (no boolean `ok` + `value`) passes through untouched, and a write result is therefore
 * never mistaken for an envelope.
 *
 * @param result - whatever the proxy answered.
 * @returns the host's return value.
 * @throws RemoteCallError when the transport itself failed.
 */
export function unwrapRemote<T>(result: unknown): T {
  const envelope = result as { ok?: unknown; value?: unknown; error?: unknown } | null
  const isRecord = envelope !== null && typeof envelope === 'object' && typeof envelope.ok === 'boolean'
  if (!isRecord) return result as T
  // A transport failure. It cannot collide with this plugin's own `WriteResult`: a write result reaches
  // the page INSIDE an envelope (`{ok:true, value:{ok:false,…}}`), so a bare `ok:false` here is the
  // carrier refusing the call, never a payload.
  if (envelope.ok === false) {
    const reason =
      typeof envelope.error === 'string' ? envelope.error : JSON.stringify(envelope.error ?? 'transport failed')
    throw new RemoteCallError(reason)
  }
  // Success: peel the payload when the envelope carries one, otherwise hand the value back unchanged
  // (a success `WriteResult` has `ok:true` and no `value`).
  return Object.hasOwn(envelope, 'value') ? (envelope.value as T) : (result as T)
}

/**
 * Wrap the raw Remote proxy so every call answers the host's payload rather than its envelope.
 *
 * The page keeps calling `remote.status(...)` and checking `result.ok` on a WRITE exactly as before;
 * the envelope stays a transport detail on one line here instead of at twelve call sites.
 *
 * @param raw - the namespace read back from `ctx.get('remote.avantfIdentity')`.
 * @returns the same face, envelope-free, or undefined when the namespace is absent.
 */
export function wrapRemote<T extends object>(raw: T | undefined): T | undefined {
  if (raw === undefined) return undefined
  const source = raw as unknown as Record<string, unknown>
  const wrapped: Record<string, unknown> = {}
  for (const method of REMOTE_METHODS) {
    const fn = source[method]
    if (typeof fn !== 'function') continue
    // ARITY IS PART OF THE CONTRACT: the transport builds `args` from the values it is handed, and the
    // gateway rejects a payload for a parameter the descriptor does not declare. A no-argument method
    // must therefore be CALLED with no arguments, not with `undefined` or an empty object.
    wrapped[method] = async (args?: unknown): Promise<unknown> =>
      unwrapRemote(
        await (fn as (this: unknown, ...values: unknown[]) => Promise<unknown>).apply(
          raw,
          args === undefined ? [] : [args],
        ),
      )
  }
  return wrapped as T
}
