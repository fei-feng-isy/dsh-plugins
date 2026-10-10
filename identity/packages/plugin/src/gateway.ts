/**
 * The host face of this plugin's Remote namespace: everything the settings page calls.
 *
 * `TypertRemoteService` publishes the Cordis service AND binds it as a Remote namespace, so the
 * browser half reaches these methods through `ctx.get('remote.avantfIdentity')` after `$mount` — never
 * through a dotted `inject` entry, which would leave the client plugin's entry pending forever (see
 * `src/client/index.ts`).
 *
 * Every method answers a plan-shaped value; none of them throws. A Remote call has no caller identity,
 * so the ONLY argument that varies per call is the locale the browser is showing — the page passes it,
 * and a headless caller falls back to the host's `locale` setting namespace, then to English.
 *
 * @module @avantf/dsh-identity/gateway
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { IdentityLogger } from './log.js'
import { FALLBACK_LOCALE } from './paths.js'
import { isValidLocale } from './presets.js'
import { NAMESPACE } from './wire.js'
import type { IdentitySettings, IdentityState, IdentityStatusView } from './state.js'

/** The profile entry id this plugin's Config lives under (the settings namespace a write targets). */
export const ENTRY_ID = 'avantf-identity'

/** The host `locale` settings namespace and its one field, mirrored from `dsh-client-locale`. */
const LOCALE_NAMESPACE = 'locale'
const LOCALE_PREFERENCE_FIELD = 'preference'

/** What a Remote call may carry when it wants a specific language: the browser's active locale. */
interface LocaleArg {
  readonly locale?: string
}

/** One write's answer, mirroring `writeResultSchema`. */
interface WriteResult {
  readonly ok: boolean
  readonly error?: string
  readonly resolvedLocale?: string
  readonly fellBack?: boolean
  readonly files?: readonly string[]
}

export class IdentityGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly state: IdentityState,
    private readonly settings: () => IdentitySettings,
    private readonly log: IdentityLogger,
  ) {
    // `TypertRemoteService` registers the service under this key AND binds it as a Remote namespace.
    super(ctx, NAMESPACE)
  }

  /** The settings page's ONE entry point: the header, the three file slots, and the preset library. */
  @Remote('status')
  status(args: LocaleArg): IdentityStatusView {
    return this.state.status(this.settings(), this.localeInfo(args.locale))
  }

  /** The preset library, with the active one marked. */
  @Remote('listPresets')
  listPresets(): { readonly presets: IdentityStatusView['presets'] } {
    return { presets: this.state.presetSummaries(this.settings().activePreset) }
  }

  /** The three files of the effective identity, with their text. */
  @Remote('readProfile')
  readProfile(): ReturnType<IdentityState['readProfile']> {
    return this.state.readProfile()
  }

  /** Write one effective-identity file. The next assembly reads it; nothing else is touched. */
  @Remote('writeProfileFile')
  writeProfileFile(args: { name: string; text: string }): WriteResult {
    const result = this.state.writeProfileFile(args.name, args.text)
    if (result.ok) this.log.info(`wrote ${args.name}.md (${String(Buffer.byteLength(args.text, 'utf8'))} bytes); the next assembly reads it`)
    return result
  }

  /** Apply a preset to the effective identity, then record which preset/locale is in force. */
  @Remote('applyPreset')
  async applyPreset(args: { id: string; locale?: string }): Promise<WriteResult> {
    const { locale } = this.localeInfo(args.locale)
    const result = this.state.applyPreset(args.id, locale)
    if (result.ok) {
      this.log.info(`applied preset ${args.id} (${String(result.resolvedLocale ?? locale)}${result.fellBack === true ? ', fell back to en' : ''})`)
      await this.remember({ activePreset: args.id, activeLocale: result.resolvedLocale ?? locale })
    }
    return result
  }

  /** Save the effective identity as a new preset under the locale the caller is showing. */
  @Remote('saveAsPreset')
  saveAsPreset(args: { id: string; locale?: string }): WriteResult {
    const { locale } = this.localeInfo(args.locale)
    return this.state.saveAsPreset(args.id, locale)
  }

  /** Read one preset (English fallback when the requested locale has no directory). */
  @Remote('readPreset')
  readPreset(args: { id: string; locale?: string }): ReturnType<IdentityState['readPreset']> {
    const { locale } = this.localeInfo(args.locale)
    return this.state.readPreset(args.id, locale)
  }

  /** Write one preset file. Never touches the effective identity (the page says so out loud). */
  @Remote('writePresetFile')
  writePresetFile(args: { id: string; name: string; text: string; locale?: string }): WriteResult {
    const { locale } = this.localeInfo(args.locale)
    return this.state.writePresetFile(args.id, args.name, args.text, locale)
  }

  /** Delete one preset from the library. */
  @Remote('deletePreset')
  deletePreset(args: { id: string }): WriteResult {
    const result = this.state.deletePreset(args.id)
    if (result.ok) this.log.info(`deleted preset ${args.id}`)
    return result
  }

  /**
   * Record which preset/locale is in force, so a later language change can offer "apply it again in
   * `<new language>`" WITHOUT ever rewriting the user's files. Best-effort: a host whose settings
   * service is absent or read-only mounts and works, it just cannot remember this.
   */
  private async remember(patch: { activePreset: string; activeLocale: string }): Promise<void> {
    try {
      const settings = this.ctx.get('settings') as
        | { update?: (ns: string, patch: object, expectedRevision?: number) => Promise<unknown> }
        | undefined
      if (settings === undefined || typeof settings.update !== 'function') return
      await settings.update(ENTRY_ID, patch)
    } catch (error) {
      this.log.warn(`could not record the active preset in the profile config (${reasonOf(error)}); the identity itself is applied`)
    }
  }

  /**
   * The language to apply in: the caller's own (UI-triggered applies always carry it), else the host's
   * explicit `locale` preference, else English.
   *
   * The browser's `locale` service exists only on the CLIENT half, so a headless caller reads the same
   * preference through the settings projection — the field `dsh-client-locale` writes only when a user
   * has explicitly chosen a language, which is exactly the "no browser to delegate to" case.
   */
  private localeInfo(requested: string | undefined): { locale: string; source: string } {
    if (typeof requested === 'string' && isValidLocale(requested)) return { locale: requested, source: 'client' }
    const host = this.hostLocale()
    if (host !== undefined) return { locale: host, source: 'host' }
    return { locale: FALLBACK_LOCALE, source: 'fallback' }
  }

  private hostLocale(): string | undefined {
    try {
      const settings = this.ctx.get('settings') as { describe?: () => unknown } | undefined
      const descriptors = settings?.describe?.()
      if (!Array.isArray(descriptors)) return undefined
      for (const descriptor of descriptors) {
        const record = descriptor as { readonly ns?: unknown; readonly value?: unknown } | null | undefined
        if (record?.ns !== LOCALE_NAMESPACE) continue
        const value = record.value as Record<string, unknown> | null | undefined
        const preference = value?.[LOCALE_PREFERENCE_FIELD]
        if (typeof preference === 'string' && isValidLocale(preference)) return preference
      }
    } catch {
      // "Cannot tell" is not a failure: the fallback locale is the documented answer.
    }
    return undefined
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
