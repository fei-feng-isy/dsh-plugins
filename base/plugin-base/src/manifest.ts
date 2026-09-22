/**
 * `install.json` — the per-version-directory manifest.
 * @module manifest
 */
import { sriOfSha256 } from './integrity.js'
import type { InstallManifest, ResourceSource } from './types.js'

export const INSTALL_MANIFEST_FILE = 'install.json'
export const MANIFEST_SCHEMA_VERSION = 1

const SOURCES: readonly ResourceSource[] = ['resolved', 'managed', 'installed', 'system', 'explicit']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Map a legacy manifest onto today's field names. */
export function aliasLegacyManifest(raw: Record<string, unknown>, kind?: string): Record<string, unknown> {
  const aliased: Record<string, unknown> = { ...raw }
  if (aliased['name'] === undefined && raw['id'] !== undefined) aliased['name'] = raw['id']
  if (aliased['integrity'] === undefined && raw['sha256'] !== undefined) {
    // Hex digests are stored as SRI base64.
    aliased['integrity'] = sriOfSha256(String(raw['sha256']))
  }
  if (aliased['tarball'] === undefined && raw['url'] !== undefined) aliased['tarball'] = raw['url']
  if (aliased['entry'] === undefined && raw['binary'] !== undefined && kind === 'binary-archive') {
    aliased['entry'] = `bin/${String(raw['binary'])}`
  }
  if (aliased['schemaVersion'] === undefined) aliased['schemaVersion'] = 0
  return aliased
}

/** Parse a manifest, applying the alias table; `undefined` when it is not a usable manifest. */
export function readInstallManifest(raw: unknown, kind?: string): InstallManifest | undefined {
  if (!isRecord(raw)) return undefined
  const aliased = aliasLegacyManifest(raw, kind)
  const name = str(aliased['name'])
  const version = str(aliased['version'])
  const dir = str(aliased['dir']) ?? version
  if (name === undefined || version === undefined || dir === undefined) return undefined
  const source = str(aliased['source'])
  const integrity = str(aliased['integrity'])
  const tarball = str(aliased['tarball'])
  const entry = str(aliased['entry'])
  const entryDir = str(aliased['entryDir'])
  return {
    schemaVersion: typeof aliased['schemaVersion'] === 'number' ? aliased['schemaVersion'] : 0,
    name,
    version,
    dir,
    ...(integrity === undefined ? {} : { integrity }),
    ...(tarball === undefined ? {} : { tarball }),
    ...(entry === undefined ? {} : { entry }),
    ...(entryDir === undefined ? {} : { entryDir }),
    installed_at: str(aliased['installed_at']) ?? '',
    source: source !== undefined && (SOURCES as readonly string[]).includes(source) ? (source as ResourceSource) : 'managed',
    layout: str(aliased['layout']) ?? '',
  }
}

/** Serialise a manifest to JSON bytes. */
export function encodeInstallManifest(manifest: InstallManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
}

/** Decode bytes that are expected to be JSON; `undefined` when they are not. */
export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}
