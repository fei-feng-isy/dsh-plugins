/**
 * Local fixture archives and a loopback HTTP source for the installer specs.
 *
 * Nothing here touches the network: the archives are built in-process and served by an HTTP server
 * bound to `127.0.0.1:0`, so a spec exercises the REAL download path (fetch → stream → digest →
 * extract → atomic rename) without depending on GitHub, a mirror, or even DNS. That is the point —
 * the mechanism must be verified on a machine that cannot reach the real release.
 *
 * The tar fixture is built with the `tar` command and the zip fixture with a hand-written writer
 * (`zip-writer.ts`): the code under test shells out to `tar` for one format and parses the other
 * itself, so an independent writer is what makes the round trip a test rather than a tautology.
 *
 * @module test/helpers/archives
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A fixture archive's bytes plus the digest and size the installer will be told to expect. */
interface FixtureArchive {
  bytes: Buffer
  sha256: string
  byteLength: number
}

/** The SHA-256 of a buffer, lowercase hex. */
export async function sha256Of(bytes: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

/** A shell script that reports the version marker a fixture artifact expects. */
function versionScript(binary: string, version: string): string {
  return `#!/bin/sh\necho "${binary} ${version}"\n`
}

function makeExecutable(path: string): void {
  chmodSync(path, 0o755)
}

/**
 * A `.tar.gz` whose extracted tree is `pandoc-3.11/bin/pandoc` (the real layout), with the binary a
 * POSIX script so it actually runs on this host.
 */
export async function buildTarGzFixture(options: {
  /** Scratch directory for the fixture's own files — always a temp dir, never the repo. */
  base: string
  /** Top-level directory INSIDE the archive (a release's version directory, e.g. `pandoc-3.11`). */
  root: string
  binary: string
  version: string
}): Promise<FixtureArchive> {
  const { base, root, binary, version } = options
  const tree = join(base, 'tar-tree')
  const binDir = join(tree, root, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, binary), versionScript(binary, version))
  makeExecutable(join(binDir, binary))
  writeFileSync(join(tree, root, 'README.txt'), 'fixture release\n')
  const archive = join(base, 'fixture.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', tree, root], { stdio: 'pipe' })
  const bytes = readFileSync(archive)
  return { bytes, sha256: await sha256Of(bytes), byteLength: bytes.length }
}

/** A ZIP with the same tree (exercises this package's own extractor, not `unzip`). */
export async function buildZipFixture(options: {
  base: string
  binary: string
  version: string
}): Promise<FixtureArchive> {
  const { base, binary, version } = options
  const tree = join(base, 'zip-tree')
  const binDir = join(tree, 'release', 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, binary), versionScript(binary, version))
  makeExecutable(join(binDir, binary))
  writeFileSync(join(tree, 'release', 'notes.txt'), 'zip fixture\n')
  const archive = join(base, 'fixture.zip')
  const { zipSync } = await import('./zip-writer.js')
  const bytes = zipSync([
    { name: 'release/bin/' + binary, data: Buffer.from(versionScript(binary, version)) },
    { name: 'release/notes.txt', data: Buffer.from('zip fixture\n') },
  ])
  writeFileSync(archive, bytes)
  return { bytes, sha256: await sha256Of(bytes), byteLength: bytes.length }
}

/** A ZIP carrying one entry at a path that escapes the destination — the ZIP SLIP fixture. */
export async function buildZipSlipFixture(options: { base: string }): Promise<FixtureArchive> {
  const { zipSync } = await import('./zip-writer.js')
  const bytes = zipSync([{ name: '../escaped.txt', data: Buffer.from('escaped\n') }])
  writeFileSync(join(options.base, 'slip.zip'), bytes)
  return { bytes, sha256: await sha256Of(bytes), byteLength: bytes.length }
}

/** A tiny HTTP server serving named fixtures; port 0 means the OS picks a free one. */
export interface FixtureServer {
  origin: string
  put(path: string, bytes: Buffer): void
  /** Every path requested, in order — so a spec can assert WHICH sources were tried. */
  requested: string[]
  close(): Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const files = new Map<string, Buffer>()
  const requests: string[] = []
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    requests.push(path)
    const body = files.get(path)
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    put(path, bytes) { files.set(path, bytes) },
    requested: requests,
    async close() {
      await new Promise<void>((resolve, reject) => { server.close(error => (error === undefined ? resolve() : reject(error))) })
    },
  }
}
