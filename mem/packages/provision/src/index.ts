/**
 * `@avantf/mem-provision` — the entry point for obtaining the external things this project depends
 * on but cannot install through pnpm.
 *
 * npm dependencies are pnpm's job and deliberately out of scope — and so is the family base
 * `@avantf/dsh-plugin-base` (the environment framework + the compatibility gate + the shared kit in
 * ONE published package): since the DSH plugin was wired to it, that package is a PEER the
 * host/profile installs, loaded at startup through the plugin's inlined bootstrap, and none of its
 * resources are downloaded into the family root any more. What stays here is the plugin's LEGACY path — third-party BINARIES (pandoc, the
 * converter every document format goes through) and derived runtime state (the warmed embedding
 * model), behind one registry, one managed directory (`~/.avantf/tools/<tool>/<version>/`), one
 * mirror list, and one startup sweep — used by the CLI, the MCP server, and the plugin whenever the
 * framework is unavailable.
 *
 * Resolution order, per artifact: ① an explicit configured path → ② the managed copy → ③ a matching
 * installation on `PATH` → ④ an explicit failure naming every platform's install command. It never
 * silently downgrades: a missing tool is an error with the per-platform fix in it, because a
 * different version changes the output.
 *
 * ## The weak-guarantee boundary, stated on purpose (architecture review 2026-10-03 §7.10)
 *
 * This is the WEAKER of the family's two provisioning stacks, and that is a frozen, reasoned
 * trade-off — not a bug waiting to be fixed and not something a future change should quietly
 * "level up" halfway.
 *
 * **What it guarantees.** Every pack is verified by size and then **sha256** before use, and the
 * built tree is published with **two renames** (`publishAtomically`): a reader sees either the old
 * complete tree or the new complete tree, never a half-written tool, and a failed second rename puts
 * the old tree back. **That is the whole guarantee.**
 *
 * **What it does NOT guarantee — deliberately.** There is **no cross-process lock**. Two processes
 * installing the same version both pay for the download and the extract, and the second publish
 * wins (last-writer-wins). That is still correct because each staging tree is complete, so whichever
 * rename lands, `bin/<binary>` is a complete binary. A real lock would have to detect its own stale
 * holders and tell the waiter when the winner finished — a coordination protocol rather than a
 * rename — and is out of scope here. The reasoning is recorded at the call site
 * (`src/fetch.ts`, `publishAtomically`), not implied.
 *
 * **It is strictly below the base's envinit framework**, which has all of that AND: a family-root
 * control-plane lock at `<home>/.envinit/.lock` with **pid authority** (a stale lock is reclaimed
 * only when the recorded pid is actually gone; a long critical section held by a LIVE process is
 * never stolen), **slow-hold warnings** when that contract is being stretched, and cross-device
 * rejection instead of a non-atomic publish. A fix that strengthens the base therefore does NOT
 * strengthen this path.
 *
 * **Why two stacks coexist, and the boundary of "hardening not synchronized".** The base is a DSH
 * host concern: a peer the profile installs, loaded at startup through the plugin's inlined
 * bootstrap. The CLI and the MCP server run with **no DSH host at all**, and the plugin needs a
 * fallback when the base is absent or incompatible (see the module header above). Those callers can
 * only use this package — removing it would make the CLI lose automatic pandoc installation. So the
 * boundary is: **base present ⇒ the base's stronger path; base absent / CLI / MCP / degraded mount
 * ⇒ this stack.** Improvements to the base do not propagate here, and an improvement here needs a
 * mem release; both facts are stated rather than left to be rediscovered.
 *
 * @module index
 */
export {
  DEFAULT_MIRRORS,
  DEFAULT_TOOLS_CONFIG,
  applyToolsEnv,
  defaultToolsDir,
  envAutoInstall,
  expandHome,
  parseToolsConfig,
  resolveToolsDir,
} from './config.js'
export { describeError, ProvisionError, type ProvisionStep } from './errors.js'
export { fetchToFile, mirrorUrl, sourceUrls } from './fetch.js'
export { IDLE_MAX_WAIT_MS, IDLE_QUIET_MS, IDLE_TOLERANCE_MS, whenEventLoopIdle } from './idle.js'
export { commandFileNames, currentPlatform, findOnPath, isExecutableFile, packKey, PROBE_TIMEOUT_MS } from './platform.js'
export {
  artifactById,
  artifacts,
  ensure,
  ensureAll,
  ensureAllAsync,
  hasArtifact,
  INSTALL_MANIFEST,
  installContext,
  installHints,
  managedBinaryPath,
  packFor,
  registerArtifact,
  resolveBinary,
  silentLogger,
  type BinaryResolution,
  type BinarySpec,
  type EnsureArtifactOptions,
  type InstallManifest,
  requirePack,
} from './registry.js'
export { binaryPath, installBinaryArtifact, runProbe, versionDir, type ProbeOutcome } from './tools.js'
export { extractZip } from './zip.js'
export {
  ensurePandoc,
  managedPandocInstalled,
  managedPandocPath,
  PANDOC_ARTIFACT_ID,
  PANDOC_BINARY,
  PANDOC_PACKS,
  PANDOC_SPEC,
  PANDOC_VERSION,
  PANDOC_VERSION_MARKER,
  pandocArtifact,
  pandocConverterId,
  pandocExecutable,
  registerPandocArtifact,
  type PandocEnsureOptions,
  type PandocEnv,
  type PandocResolution,
} from './artifacts/pandoc.js'
export {
  detectLibreOffice,
  LIBREOFFICE_SPEC,
  libreOfficeHint,
  LEGACY_OFFICE_HINT,
} from './artifacts/libreoffice.js'
export type {
  ArchivePack,
  Artifact,
  ArtifactSource,
  EnsureOptions,
  EnsureResult,
  InstallContext,
  PlatformKey,
  PlatformPacks,
  ProvisionConfig,
  ProvisionLogger,
  VerifyContext,
} from './types.js'

// Registering on import is deliberate for the artifacts compiled into the core bundle: a caller that
// imports this package gets the tools it has built in. An artifact whose registration needs
// per-runtime state (the model warm-up) is registered by ITS owner (`@avantf/mem`), not here.
import './artifacts/pandoc.js'
import { registerPandocArtifact } from './artifacts/pandoc.js'
registerPandocArtifact()
