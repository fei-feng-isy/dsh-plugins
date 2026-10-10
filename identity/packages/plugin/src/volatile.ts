/**
 * Reading one Config field.
 *
 * The plugin's settings fields are `schemastery` `.volatile()` references, because that is what makes
 * the host project them into a live settings form which writes back to the profile patch and hot-reloads
 * the row (see the spec §3.4). A volatile field is READ through `.get()`: the field itself is a stable
 * reference whose value the runtime swaps, so a captured `config.enabled` would be a snapshot and the
 * switch would appear to do nothing until a restart.
 *
 * The seam is deliberate: a test (and the mount smoke) mounts the plugin with a PLAIN config object.
 * Accepting both shapes here is what keeps "read the live value" and "mountable with a literal" from
 * being two different code paths.
 *
 * @module @avantf/dsh-identity/volatile
 */

/** A field that is either a live reference or a plain value. */
export type MaybeVolatile<T> = T | { get(): T }

/**
 * Read one Config field, whatever shape it arrived in.
 *
 * `fallback` covers the three "no value" spellings a live reference can produce: an absent field, a
 * `get()` that answers `undefined`, and a `get()` that throws (a torn-down runtime must not break the
 * prompt assembly it is describing).
 */
export function volatileValue<T>(field: MaybeVolatile<T | undefined> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  const get = (field as { get?: unknown }).get
  if (typeof get === 'function') {
    try {
      const value = (get as () => unknown).call(field)
      return value === undefined ? fallback : value as T
    } catch {
      return fallback
    }
  }
  return field as T
}
