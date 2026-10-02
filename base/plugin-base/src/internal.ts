/**
 * Framework building blocks shared by the core and the entry points.
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
