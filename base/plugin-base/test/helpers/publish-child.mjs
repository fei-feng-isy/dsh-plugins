/**
 * One publisher process, for the cross-process publish-once test.
 *
 * Started twice with the same `home`; both wait for a start file, then race. It prints the count of
 * renames that landed in the resource root, which is what "发布只一次" is actually about — two
 * processes may both *download*, but only one may move a directory into place.
 *
 * argv: <dist/index.js file URL> <home> <tarball path> <integrity> <start file>
 *
 * @module test/helpers/publish-child
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [, , entryUrl, home, tarballPath, integrity, startPath] = process.argv
if (entryUrl === undefined || home === undefined || tarballPath === undefined || integrity === undefined || startPath === undefined) {
  process.stderr.write('publish-child: missing arguments\n')
  process.exit(2)
}

const api = await import(entryUrl)
// The injection seams (`defaultFs`) AND the zero-consumer composition pieces generation v3 moved off
// `.` (`npmPackageProvider`) come from the documented internal entry rather than the public one.
const internalEntryUrl = entryUrl.replace(/index\.js$/, 'internal.js')
const internal = await import(internalEntryUrl)
const tarball = readFileSync(tarballPath)
const targetRoot = `${home}/runtime/`

const inner = internal.defaultFs()
const renamed = []
const fs = {
  ...inner,
  async rename(from, to) {
    if (to.startsWith(targetRoot)) renamed.push(to)
    await inner.rename(from, to)
  },
}

const fetchImpl = async input =>
  String(input).endsWith('.tgz')
    ? new Response(tarball, { status: 200 })
    : new Response(
        JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/demo-pkg/-/demo-pkg-1.0.0.tgz', integrity } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const created = api.createProvisioner({ home, logger, fs, fetch: fetchImpl })
created.register(internal.npmPackageProvider())
created.declare({
  plugin: 'mem',
  items: [{ id: 'mem:demo', kind: 'npm-package', spec: { name: 'demo-pkg', range: '^1.0.0' }, target: { root: 'runtime' }, schemaVersion: 1 }],
})

// Start together: whoever writes the start file first releases both.
while (true) {
  try {
    readFileSync(startPath)
    break
  } catch {
    await sleep(2)
  }
}

const report = await created.ensure()
process.stdout.write(JSON.stringify({ renamed: renamed.length, actions: report.entries.map(entry => entry.action) }))
