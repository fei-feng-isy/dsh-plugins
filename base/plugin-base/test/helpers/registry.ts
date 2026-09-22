/**
 * A fake npm registry for provider/core tests: one package, one version, a real tarball.
 *
 * @module test/helpers/registry
 */
import { createHash } from 'node:crypto'
import { tarGz } from './tar.js'

export interface PackageContents {
  readonly name?: string
  readonly version?: string
  readonly entry?: string
  /** Extra `package/…` entries, e.g. `binding.gyp` or a `peerDependencies` manifest. */
  readonly extra?: readonly { readonly name: string; readonly data: string }[]
  /** Merged into the generated `package.json` (peerDependencies, scripts, …). */
  readonly packageJson?: Record<string, unknown>
}

export function packageTarball(contents: PackageContents = {}): Uint8Array {
  const name = contents.name ?? 'demo-pkg'
  const version = contents.version ?? '1.0.0'
  const entries = [
    {
      name: 'package/package.json',
      data: JSON.stringify({ name, version, type: 'module', main: 'index.js', ...contents.packageJson }),
    },
    { name: 'package/index.js', data: contents.entry ?? 'export const ok = true\n' },
  ]
  for (const extra of contents.extra ?? []) entries.push({ name: extra.name, data: extra.data })
  return tarGz(entries)
}

export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** A `fetch` that serves the packument and the tarball. */
export function registryFor(name: string, version: string, tarball: Uint8Array, integrity: string | undefined): typeof fetch {
  const packument = {
    versions: {
      [version]: {
        dist: {
          tarball: `https://registry.test/${name}/-/${name}-${version}.tgz`,
          ...(integrity === undefined ? {} : { integrity }),
        },
      },
    },
  }
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith('.tgz')) return new Response(tarball, { status: 200 })
    return new Response(JSON.stringify(packument), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/** A `fetch` that fails the test if it is ever called. */
export function noNetwork(): typeof fetch {
  return (async () => {
    throw new Error('test: network must not be used')
  }) as unknown as typeof fetch
}
