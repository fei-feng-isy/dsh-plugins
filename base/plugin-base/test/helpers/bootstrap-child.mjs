/**
 * One caller process for the bootstrap's resolution contract.
 *
 * The inlined bootstrap is plain JavaScript with no relative imports, so a child can import a COPY of
 * it from a scratch tree and observe what a real caller's module resolution sees there: the framework
 * installed beside it, or nothing at all. That is the only way to test "the package manager's copy is
 * the only source", because in-process resolution would find this repository itself.
 *
 * argv: <copied bootstrap .mjs path> <absent|present|unsupported> [optionsJson]
 *
 * It prints one JSON line — `{ warnings, location, marker }` — after replacing `globalThis.fetch`
 * with a thrower, so a bootstrap that reaches for the registry fails loudly instead of passing.
 *
 * @module test/helpers/bootstrap-child
 */
import { pathToFileURL } from 'node:url'

const [, , bootstrapPath, scenario, optionsJson] = process.argv
if (bootstrapPath === undefined || scenario === undefined) {
  process.stderr.write('bootstrap-child: missing arguments\n')
  process.exit(2)
}

globalThis.fetch = () => {
  throw new Error('bootstrap called fetch: it must never reach the registry')
}

const options = optionsJson === undefined ? {} : JSON.parse(optionsJson)
const warnings = []
const logger = { warn: message => warnings.push(message), info: () => undefined }
const api = await import(pathToFileURL(bootstrapPath).href)

let location
let marker
if (scenario === 'present') {
  const framework = await api.loadFramework({ logger, ...options })
  marker = framework?.marker
  location = framework === undefined ? undefined : 'loaded'
} else {
  location = await api.ensureFramework({ logger, ...options })
}

process.stdout.write(`${JSON.stringify({ warnings, location, marker })}\n`)
