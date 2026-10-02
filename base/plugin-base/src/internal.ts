/**
 * Framework building blocks shared by the core and the entry points.
 *
 * `./internal` is the second published subpath beside `.` and it carries everything the compatibility
 * promise deliberately does NOT cover (root `AGENTS.md`; `docs/INTERFACE.md` §2/§5):
 *
 *  - the framework's own seams (fs, locks, archives, layout, lint, semver …), and
 *  - the **composition pieces** of the pieces `.` does export: the individual probes and evidence
 *    helpers `compat.gatherEvidence` is built from, the provisioner's policy helpers and constants,
 *    the npm-package provider, and the Typert symbol kit whose symbols/wire helpers the two plugins
 *    keep as LOCAL mirrors by design (they are assembled at module load, before any base can be
 *    imported).
 *
 * Generation v3 moved exactly those zero-consumer names here (INTERFACE.md §9). `./internal` is NOT
 * part of the interface surface: nothing on it is covered by the generation gate, so plugin authors
 * must take their members off `.`. The names here are reachable for the base's own tests and for a
 * consumer that genuinely needs a framework seam.
 *
 * @module internal
 */
export { defaultFs, exists, linkOrCopy } from './fs.js'
export { defaultLock, pidIsAlive } from './lock.js'
export { extractTarGz, safeEntryPath } from './tar.js'
export { extractZip } from './zip.js'
export type { ZipExtractOptions } from './zip.js'
export { assertRange, compareVersions, parseRange, parseVersion, satisfies, satisfiesRange, selectVersion } from './semver.js'
export type { Range, Version } from './semver.js'
export {
  INSTALL_MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  aliasLegacyManifest,
  decodeJson,
  encodeInstallManifest,
  readInstallManifest,
} from './manifest.js'
export { assertPackageName } from './package-name.js'
export { sriOfSha256, verifyIntegrity } from './integrity.js'
export {
  LAYOUT_SCHEMA_VERSION,
  STATUS_SCHEMA_VERSION,
  mergeRows,
  persistStatus,
  readDeclared,
  readLayout,
  readStatus,
  recordDeclared,
  writeLayout,
} from './state.js'
export type { DeclaredEntry, DeclaredFile, LayoutFile, StatusFile, StatusRow } from './state.js'
export {
  BUILTIN_KINDS,
  IMPLEMENTED_POLICY_KEYS,
  ITEM_FIELDS,
  MANIFEST_FIELDS,
  UNIMPLEMENTED_POLICY_KEYS,
  UNIMPLEMENTED_PROVISION_POLICY_KEYS,
  hasStarBranch,
  isNamespacedKind,
  lintManifest,
  lintManifestText,
  unknownFields,
} from './lint.js'
export type { LintFinding, LintResult } from './lint.js'
export { candidateUrls, downloadBytes, fetchImplOf, platformKey, readCapped, signalFor, verifySha256, DEFAULT_MAX_BYTES, METADATA_MAX_BYTES } from './net.js'
export {
  CONTROL_DIR,
  assertSafeRelativePath,
  assertSafeRelativeRoot,
  controlRoot,
  declaredPath,
  layoutPath,
  lockPath,
  quarantineRoot,
  stagingDir,
  statusLockPath,
  statusPath,
  tempRoot,
  versionSegment,
} from './layout.js'
export {
  BOOTSTRAP_SUBPATH,
  FRAMEWORK_INLINING_BEACONS,
  FRAMEWORK_PACKAGE,
  MIN_INLINING_BEACONS,
  findFrameworkImports,
  findInliningBeacons,
  isBootstrapSpecifier,
} from './artifact.js'
export type { FrameworkImportKind, FrameworkImportRef } from './artifact.js'

// ── generation v3: the names `.` shed ────────────────────────────────────────────────────────────
// Each of these has zero consumers across the two plugin trees' non-test source and scripts
// (`test/public-surface.spec.ts` re-proves that mechanically). They are composition pieces of the
// members `.` still exports, or kit mirrors the plugins keep locally on purpose — never a plugin's
// entry point. Their canonical home is here; INTERFACE.md §9 records why each one moved.
export {
  COMPAT_PROBE_TOOL,
  checkInterval,
  checkServices,
  declaredSchemaKeys,
  floorOf,
  probeToolsRegistry,
  probeTypertRegistry,
  resolveRuntimeVersion,
} from './compat.js'
export { CAPABILITIES, DEFAULT_DEADLINE_MS, normalizeOnMissing } from './provisioner.js'
export { NPM_PACKAGE_KIND, npmPackageProvider } from './providers/npm.js'
export type { NpmPackageSpec } from './providers/npm.js'
export { createPluginLogger } from './kit/logger.js'
export type { PluginLogger, PluginLoggerHost, PluginLoggerOptions } from './kit/logger.js'
export { endpointId, fieldSymbol, resultSymbol, strictCodec } from './kit/typert.js'
export type { StrictCodec } from './kit/typert.js'
