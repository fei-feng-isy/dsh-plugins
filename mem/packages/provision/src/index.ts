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
