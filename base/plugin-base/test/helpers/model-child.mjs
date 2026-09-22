/**
 * Child process for the cross-process `model-cache` completion-marker check. Plain JavaScript, so
 * it can import the built package the way a plugin would.
 *
 * @module test/helpers/model-child
 */
import { createProvisioner } from '../../dist/provisioner.js'
import { modelCacheProvider } from '../../dist/providers/model.js'
import { defaultFs } from '../../dist/fs.js'

const [home, layout, revision, sha, content, repo] = process.argv.slice(2)
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A fixed endpoint; the delays widen the window in which two processes overlap. */
const fetchImpl = async input => {
  const url = String(input)
  if (/\/api\/models\/.+\/revision\//.test(url)) {
    await delay(30)
    return new Response(JSON.stringify({ sha }), { status: 200 })
  }
  if (url.endsWith(`/api/models/${repo}`)) {
    return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }] }), { status: 200 })
  }
  await delay(60)
  return new Response(content, { status: 200 })
}

const provisioner = createProvisioner({ home, logger: silent, fs: defaultFs(), fetch: fetchImpl })
provisioner.register(modelCacheProvider())
provisioner.declare({
  plugin: 'mem',
  items: [
    {
      id: 'mem:model',
      kind: 'model-cache',
      spec: { repo, layout, files: ['config.json'], revision },
      target: { root: 'models' },
      schemaVersion: 1,
    },
  ],
})
const report = await provisioner.ensure()
process.stdout.write(`${JSON.stringify(report.entries[0] ?? null)}\n`)
