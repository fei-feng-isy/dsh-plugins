/**
 * This plugin's producer-owned message source.
 *
 * DSH V4 retired the shared `plugin` wrapper: every durable message declares the producer that owns
 * it, and the V3→V4 migration rewrites a released `{ kind: 'plugin', plugin: 'avantf-mission' }` wrapper
 * to `{ kind: 'plugin:avantf-mission' }` (an unknown producer name keeps its complete string after the
 * prefix). Wakes written from now on declare that same kind, so a wake queued before the migration
 * and one written after it are one producer to the pre-step gate — and the kind is admitted by a V4
 * writer, which refuses both an empty kind and the retired `plugin` one.
 *
 * @module @avantf/dsh-mission/source
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:avantf-mission': { kind: 'plugin:avantf-mission' }
  }
}

/** The producer-owned source kind of every wake this plugin writes. */
export const OWN_WAKE_SOURCE_KIND = 'plugin:avantf-mission'
