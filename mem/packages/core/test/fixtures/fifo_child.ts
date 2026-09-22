/**
 * Child-process helper for the ingestion FIFO guard.
 *
 * A regression here does not FAIL, it HANGS: `readFileSync` on a FIFO blocks until a
 * writer appears and is synchronous, so neither vitest's timeout nor a signal handler
 * inside the same process can interrupt it. Running the two reads in a child lets the
 * parent enforce a hard kill deadline, turning a would-be CI hang into a test failure.
 *
 * Run through vite-node (the runner vitest itself uses) so it imports the real
 * TypeScript sources — no build step, no duplicated logic.
 *
 * Env: AVANTF_CHILD_HOME (data home, with `knowledge.ingest.allow_outside_workspace`),
 *      AVANTF_CHILD_FIFO (a FIFO to ingest directly),
 *      AVANTF_CHILD_DIR  (a directory holding one text file and one FIFO).
 */
import { buildRuntime } from '../../src/runtime.js'

const home = process.env['AVANTF_CHILD_HOME']
const fifo = process.env['AVANTF_CHILD_FIFO']
const dir = process.env['AVANTF_CHILD_DIR']
if (!home || !fifo || !dir) throw new Error('AVANTF_CHILD_HOME, AVANTF_CHILD_FIFO and AVANTF_CHILD_DIR are required')

const rt = buildRuntime({ dataHome: home })

let ingestError = ''
try {
  await rt.kb({ action: 'ingest', source_uri: fifo, domain: 'tech', source: 'fifo' })
  ingestError = '(no error — the FIFO was read!)'
} catch (error) {
  ingestError = error instanceof Error ? error.message : String(error)
}

const res = (await rt.kb({ action: 'import', paths: [dir], domain: 'tech', source: 'docs' })) as {
  imported: unknown[]
  failed: { path: string; error: string }[]
}

process.stdout.write(JSON.stringify({
  ingestError,
  imported: res.imported.length,
  failed: res.failed.map((f) => ({ file: f.path.split('/').pop(), error: f.error })),
}))
rt.shutdown()
