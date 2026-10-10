/**
 * The base half of this plugin's startup: load the family framework, judge the interface generation,
 * and hand back a data-home resolver.
 *
 * The base is NEVER statically imported (a value import would throw before the inlined bootstrap ran);
 * it is loaded through the vendored bootstrap and every member is read off the loaded module. Nothing
 * here throws, and nothing here refuses the mount: a base that is absent, older, or from another
 * interface generation answers `undefined`, and the identity mechanism itself — the prompt section and
 * the waterfall filter — does not depend on the base at all. The caller then resolves the data home
 * with `paths.ts`'s deliberate mirror.
 *
 * `undefined` (rather than a degraded runtime) is the family contract the base-swap proof asserts:
 * an OLDER interface generation must be WITHHELD, and the proof drives exactly this entry point
 * (`loadCompat`) with a swapped base module to see that.
 *
 * @module @avantf/dsh-identity/base
 */
import type { DataHomeInput } from '@avantf/dsh-plugin-base'
import { loadFramework } from './envinit-bootstrap.js'
import { createLoadCache, gateOrDegrade, loadGuarded, type DegradeWords } from './interface_gate.js'
import type { IdentityLogger } from './log.js'
import { resolveDataHomeMirror } from './paths.js'

/** The framework package, as declared in this plugin's `dependencies`. */
const FRAMEWORK_PACKAGE = '@avantf/dsh-plugin-base'

/** The framework's module shape; `import type` only — the value is always loaded dynamically. */
type BaseModule = typeof import('@avantf/dsh-plugin-base')

/**
 * The sentences this plugin owns; the shared shim owns the mechanism. `prefix` is the token one grep
 * finds every startup line by, matching the family's `envinit:` convention.
 */
const DEGRADE_WORDS: DegradeWords = {
  prefix: 'envinit:',
  loadFailure: 'the identity plugin mounts with its own data-home resolution and no shared base capabilities',
  withheld: `the family data-home rule comes from this plugin's own mirror instead of ${FRAMEWORK_PACKAGE}`,
}

/** What the rest of the plugin needs from the base: the module and a data-home resolver. */
export interface IdentityBase {
  /** The loaded base, always usable (an unusable one answers `undefined` from {@link loadBase}). */
  readonly module: BaseModule
  /** Resolve the family data root through the base's own rule. */
  dataHome(input: DataHomeInput): string
}

export interface LoadBaseOptions {
  readonly log?: IdentityLogger
  /**
   * Test/proof seam: the already-loaded base module to judge and use, INSTEAD of resolving one through
   * the bootstrap. `prove-base-swap.mjs` drives the built loader with a swapped base this way.
   */
  readonly framework?: BaseModule
}

async function loadBaseOnce(options: LoadBaseOptions): Promise<IdentityBase | undefined> {
  const log = options.log
  const module = options.framework ?? await loadFramework<BaseModule>({
    logger: {
      warn: (message) => { log?.warn(`${FRAMEWORK_PACKAGE}: ${message}`) },
      info: (message) => { log?.info(`${FRAMEWORK_PACKAGE}: ${message}`) },
    },
  })
  if (module === undefined) {
    log?.warn(`${FRAMEWORK_PACKAGE} could not be made available; the identity plugin mounts anyway and resolves the data home with its own mirror`)
    return undefined
  }
  // The runtime interface gate, on its own axis: the generation this artifact was baked for versus the
  // one the loaded base reports. `incompatible` WITHHOLDS the base (the caller falls back to the
  // mirror); "cannot tell" warns and uses it anyway — "cannot tell" is never "incompatible".
  if (!gateOrDegrade(module, log, DEGRADE_WORDS)) return undefined
  return { module, dataHome: (input) => readDataHome(module, input) }
}

/** One guarded call into the loaded base's resolver; any surprise falls back to the mirror. */
function readDataHome(module: BaseModule, input: DataHomeInput): string {
  try {
    if (typeof module.resolveDataHome === 'function') return module.resolveDataHome(input)
  } catch {
    // A base that throws on its own resolver is "cannot tell", not a mount failure.
  }
  return resolveDataHomeMirror(input)
}

const cache = createLoadCache<LoadBaseOptions, IdentityBase>((options) =>
  loadGuarded(options, loadBaseOnce, options.log, DEGRADE_WORDS))

/**
 * Load (once per process) the base half.
 *
 * Never rejects. `undefined` means "use this plugin's own data-home mirror" — an absent base, or one
 * whose interface generation is not the one this build was written for.
 */
export function loadBase(options: LoadBaseOptions = {}): Promise<IdentityBase | undefined> {
  return cache.load(options)
}
