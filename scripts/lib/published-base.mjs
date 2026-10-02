/**
 * Reading the INTERFACE GENERATION a PUBLISHED base actually carries — the release-time half of the
 * family's interface gate (R1).
 *
 * WHY THIS EXISTS. A plugin's peer RANGE says which base VERSIONS a host may have; it says nothing
 * about the interface GENERATION inside them. Version and generation are two axes (INTERFACE.md §1):
 * a plugin built against generation 2 satisfies `>=0.3.0 <1.0.0`, so a published base 0.3.1 carrying
 * generation 1 passes a range-only release gate — and then every user whose profile already has 0.3.1
 * mounts the plugin with `checkInterface(2, {v:1}) → incompatible`, silently losing the compat gate,
 * the prompt-file layer and the envinit provisioner. The gate has to read the generation off the
 * artifact, not off the range.
 *
 * HOW IT JUDGES. The registry metadata names a tarball; this module pulls the two places a built base
 * can record its generation out of it — `dist/interface.js` (where the exported constant lives today)
 * and, if a future base also ships one, `lib/interface-version.json` — and returns ONE number, or a
 * reason it could not. `scripts/release-check.mjs` supplies the network half and asks
 * {@link interfaceGenerationVerdict}: a published generation BELOW the plugin's bake is the one fatal
 * outcome; offline, an unreachable registry and an artifact that records nothing are WARNINGS, because
 * a local gate must not turn red just because the network is down.
 *
 * Pure where it matters: the network lives in the executable, this module reads texts and compares
 * numbers, so `scripts/gates.test.mjs` can replay every branch on constructed input.
 *
 * @module scripts/lib/published-base
 */
import { gunzipSync } from 'node:zlib'

/** Where a published base records the generation it was built from, relative to the unpacked package. */
export const INTERFACE_RECORD_PATH = 'package/lib/interface-version.json'
/** Where a tsc-built base exports the constant. The generation lives here today (base files: ["dist"]). */
export const INTERFACE_SOURCE_PATH = 'package/dist/interface.js'

/** npm tarball entry names are budgeted at 100 bytes (plus the ustar `prefix`); ours are far shorter. */
const BLOCK = 512

/**
 * The generation a built base's `dist/interface.js` exports, parsed from its text.
 *
 * A regex rather than an `import()`: the artifact under judgement is an unpacked tarball that may sit
 * in a temp directory with no resolvable dependencies, and `interface.js` is a leaf module — reading
 * its one exported constant must not depend on loading the whole base. Exactly one DISTINCT value is
 * required: prose mentioning the name does not match (`NAME = <digits>` does), and a file claiming two
 * different generations is not a generation.
 *
 * @param text - the file's contents, or `undefined` when it is absent.
 * @returns the positive integer, or `undefined`.
 */
export function interfaceGenerationFromSource(text) {
  if (typeof text !== 'string') return undefined
  const found = new Set()
  for (const match of text.matchAll(/\bINTERFACE_VERSION\s*=\s*(\d+)\b/gu)) found.add(Number(match[1]))
  if (found.size !== 1) return undefined
  const [value] = found
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The generation a base's `lib/interface-version.json` records — the same shape the plugin bake uses
 * (`{ baseVersion, interfaceVersion }`), so a base that starts publishing one needs no second reader.
 *
 * @param text - the file's contents, or `undefined` when it is absent.
 * @returns `{ interfaceVersion, baseVersion }` with `baseVersion` possibly `undefined`, or `undefined`.
 */
export function interfaceGenerationFromRecord(text) {
  if (typeof text !== 'string') return undefined
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { interfaceVersion, baseVersion } = parsed
    if (!Number.isInteger(interfaceVersion) || interfaceVersion <= 0) return undefined
    return {
      interfaceVersion,
      baseVersion: typeof baseVersion === 'string' && baseVersion !== '' ? baseVersion : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * The single generation an unpacked base artifact carries, from whichever of the two files are there.
 *
 * `ok` — at least one source records a positive integer and, when BOTH are present, they agree.
 * `conflict` — both are present and disagree; the artifact is self-contradictory, so no number can be
 * trusted (the caller treats this as a real defect, not as "unreadable").
 * `unreadable` — neither source yields a generation (missing files, malformed JSON, no constant).
 *
 * @param sources - `{ record, source }`: the two files' texts, either possibly `undefined`.
 * @returns a discriminated result the verdict below consumes.
 */
export function publishedInterfaceGeneration({ record, source } = {}) {
  const fromRecord = interfaceGenerationFromRecord(record)
  const fromSource = interfaceGenerationFromSource(source)
  if (fromRecord !== undefined && fromSource !== undefined && fromRecord.interfaceVersion !== fromSource) {
    return {
      status: 'conflict',
      detail: `${INTERFACE_RECORD_PATH} says interface generation ${fromRecord.interfaceVersion} `
        + `but ${INTERFACE_SOURCE_PATH} says ${fromSource}`,
    }
  }
  const interfaceVersion = fromRecord?.interfaceVersion ?? fromSource
  if (interfaceVersion === undefined) {
    return {
      status: 'unreadable',
      detail: `neither ${INTERFACE_RECORD_PATH} nor ${INTERFACE_SOURCE_PATH} records a positive integer INTERFACE_VERSION`,
    }
  }
  const from = []
  if (fromRecord !== undefined) from.push(INTERFACE_RECORD_PATH)
  if (fromSource !== undefined) from.push(INTERFACE_SOURCE_PATH)
  return { status: 'ok', interfaceVersion, baseVersion: fromRecord?.baseVersion, from }
}

/**
 * The R1 judgement: does the published base carry an interface generation the plugin was built for?
 *
 * Fatal ONLY when a readable published generation is BELOW the bake — that is the confirmed
 * "released plugins break against the base users already have" case, and the fix is one command. Every
 * other unreadable shape (no artifact, no record, an unreachable registry) degrades to a WARNING, and
 * `--allow-missing-base` downgrades even the fatal one for a pre-publication dry run.
 *
 * @param judgement - `{ plugin, baseVersion, published, bake, baseDir, allowMissingBase }`.
 *   `bake` is the plugin's `lib/interface-version.json` contents (`undefined` when unreadable),
 *   `published` is {@link publishedInterfaceGeneration}'s result, `baseDir` names the package in the
 *   fix command. Pure.
 * @returns `{ level: 'ok' | 'warn' | 'fail', message }`; the caller prints `message` as a note or a
 *   failure, so the two cannot drift apart.
 */
export function interfaceGenerationVerdict({
  plugin, baseVersion, published, bake, baseDir = 'base/plugin-base', allowMissingBase = false,
}) {
  if (bake === undefined || !Number.isInteger(bake.interfaceVersion) || bake.interfaceVersion <= 0) {
    return {
      level: 'warn',
      message: `WARNING: ${plugin} has no readable lib/interface-version.json — which base interface `
        + 'generation it was built against cannot be told, so it was not compared (rebuild the plugin first)',
    }
  }
  if (published === undefined) {
    return {
      level: 'warn',
      message: `WARNING: ${plugin}: the interface generation of the published base ${baseVersion} was `
        + 'not read (the registry probe did not run) — the publish order was not verified',
    }
  }
  if (published.status === 'conflict') {
    return {
      level: 'fail',
      message: `${plugin}: the published base ${baseVersion} contradicts itself — ${published.detail}. `
        + 'A base that cannot state its own interface generation must be fixed and re-published before '
        + 'a plugin is released against it.',
    }
  }
  if (published.status !== 'ok') {
    return {
      level: 'warn',
      message: `WARNING: ${plugin}: could not read the interface generation inside the published base `
        + `${baseVersion} (${published.detail}) — the published generation was NOT compared with the plugin's bake`,
    }
  }
  const detail =
    `${plugin}: the published base ${baseVersion} carries interface generation ${published.interfaceVersion}; `
    + `the plugin was built against generation ${bake.interfaceVersion} (base ${bake.baseVersion})`
  if (published.interfaceVersion < bake.interfaceVersion) {
    if (allowMissingBase) {
      return {
        level: 'warn',
        message: `WARNING: ${detail} — LOWER than the baked generation, so an already-installed `
          + 'base would degrade the plugin (--allow-missing-base given, so this is not fatal)',
      }
    }
    return {
      level: 'fail',
      message: `${detail} — the plugin needs an interface generation the published base does not have.\n`
        + '    Publish the base FIRST:\n'
        + `      pnpm -C ${baseDir} publish\n`
        + '    or, for a pre-publication dry run, re-run with:\n'
        + '      node scripts/release-check.mjs --allow-missing-base',
    }
  }
  return { level: 'ok', message: `${detail} — the published generation is not below the bake` }
}

/**
 * One named file's text out of a (gzipped) npm tarball, without a tar dependency.
 *
 * WHY A HAND-ROLLED READER. The gate is deliberately dependency-free so it can run before
 * `node_modules` exists, and the only thing it needs from the tarball is one or two short text files.
 * The subset implemented is exactly npm's packing shape: ustar headers with an octal `size`, regular
 * files (`typeflag` `0`/NUL), the `prefix` field for long paths, and 512-byte padding. Anything else
 * (pax/long-name headers, links, devices) is skipped by the same size arithmetic, and an entry that is
 * not there simply returns `undefined` — never a throw.
 *
 * @param tarball - the tarball's bytes (gzip or raw tar).
 * @param wanted - the exact entry name, e.g. {@link INTERFACE_SOURCE_PATH}.
 * @param options - `gunzip` is injectable for a test that feeds raw tar.
 * @returns the entry's UTF-8 text, or `undefined`.
 */
export function readTarballEntry(tarball, wanted, { gunzip = gunzipSync } = {}) {
  const buffer = Buffer.isBuffer(tarball) ? tarball : Buffer.from(tarball)
  const raw = buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzip(buffer) : buffer
  for (const entry of tarEntries(raw)) {
    if (entry.name === wanted) return raw.subarray(entry.start, entry.start + entry.size).toString('utf8')
  }
  return undefined
}

/** Walk the regular files of a raw tar buffer, yielding `{ name, size, start }`. */
function* tarEntries(tar) {
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) return
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const size = tarOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0x30)
    if (!Number.isFinite(size) || size < 0) return
    const start = offset + BLOCK
    if (type === '0' || type === '\0' || type === ' ') {
      yield { name: prefix === '' ? name : `${prefix}/${name}`, size, start }
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK
  }
}

/** A NUL-terminated field as text. */
function tarText(buffer, start, length) {
  const field = buffer.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8').trim()
}

/** A NUL/space-terminated octal field as a number (`NaN` when it is not one). */
function tarOctal(buffer, start, length) {
  const text = tarText(buffer, start, length)
  return text === '' ? 0 : Number.parseInt(text, 8)
}
