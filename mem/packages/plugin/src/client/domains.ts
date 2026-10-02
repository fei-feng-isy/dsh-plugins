/**
 * The 知识域 picker's option list.
 *
 * The host's `kbDomains` returns `knowledge.domains` (the configured allowlist) ∪ the domains the
 * library already holds. The union is the point: a historical name that the allowlist would not
 * accept as NEW must stay selectable, or the tab offers a value the store then refuses.
 * `restricted` mirrors "the allowlist is non-empty" — then the control is a closed `<select>` and
 * a new domain is a config change, not a second spelling of an existing one. An explicitly empty
 * allowlist means no restriction, so the control stays a free input.
 *
 * `DomainCatalog` itself is the CONTRACT's type (type-only import, erased from the bundle): the
 * host store's `domainCatalog()` return and this picker name the same declaration, so the shape
 * cannot be copied wrong on one half.
 */
import type { DomainCatalog } from '@avantf/mem-contract'

/** One `<option>`: `value` is what the form sends, `label` is what the user reads. */
export interface DomainOption {
  value: string
  label: string
}

/** The empty choice first, then every catalog domain in the host's order. */
export function domainOptions(catalog: DomainCatalog | null, emptyLabel: string): DomainOption[] {
  const domains = catalog === null ? [] : catalog.domains
  return [{ value: '', label: emptyLabel }, ...domains.map(domain => ({ value: domain, label: domain }))]
}

/**
 * `'select'` when the allowlist is active (non-empty) — the control must not offer free input, or
 * two spellings of one domain can still be created. `'input'` when it is empty (no restriction),
 * and also while the catalog is not loaded yet: the form stays usable and the store is the final
 * guard either way.
 */
export function domainPickerMode(catalog: DomainCatalog | null): 'select' | 'input' {
  return catalog !== null && catalog.restricted ? 'select' : 'input'
}

/**
 * What the 「+」 draft means, so the form and the store agree on the rules BEFORE a round-trip.
 *
 * `existing` is not an error: a name the picker already offers is a SELECTION (the user typed the
 * option instead of choosing it), and writing it a second time would only produce a duplicate list
 * entry. `invalid` is the case that must never reach the store: a `/` or `\` would become one level
 * of the managed path (`docs/<domain>/<source>/<title>.md`), and `sanitizeSegment` rewrites it — so
 * the picker would show a name that is not the directory name.
 */
export type NewDomainCheck =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'existing'; name: string }
  | { kind: 'new'; name: string }

/** Classify one 「+」 draft against the domains the picker currently offers. */
export function checkNewDomain(raw: string, existing: readonly string[]): NewDomainCheck {
  const name = raw.trim()
  if (name === '') return { kind: 'empty' }
  if (name.includes('/') || name.includes('\\')) {
    return { kind: 'invalid', reason: '知识域不能包含 “/” 或 “\\”' }
  }
  return existing.includes(name) ? { kind: 'existing', name } : { kind: 'new', name }
}
