import {
  ENTITY_SWEEP_BATCH,
  EXPORT_STATUSES,
  buildRuntime,
  codecForExportPath,
  decodeFactsExport,
  encodeFactsExport,
  exportFacts,
  importFacts,
  mergeDb,
  parseFactsExport,
  serializeFactsExport,
  warmModels,
  type FactsExportCodec,
} from '@avantf/mem'
import {
  AdminUnion,
  CONTRADICTION_RESOLUTIONS,
  DEFAULT_KB_SOURCE,
  DEGRADED_LEG_NOTE,
  FACT_STATUSES,
  KbUnion,
  QUERY_KINDS,
  QueryUnion,
  RecallUnion,
  RememberUnion,
  validationError,
} from '@avantf/mem-contract'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** A contract union, seen only through the `safeParse` this file calls. */
interface Validatable<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } }
}

/**
 * Validate one CLI-built request against the contract union BEFORE dispatch, and refuse it here.
 *
 * The CLI is the only surface that assembles a request out of raw argv, and it used to hand the
 * result to the runtime behind an `as` cast: a flag the contract does not accept then failed
 * somewhere inside a store (or was ignored) instead of being refused at the boundary the way the DSH
 * tools and the MCP server refuse it. The message is the shared `validationError` rendering, so the
 * three surfaces disagree about nothing.
 */
function validated<T>(union: Validatable<T>, value: unknown): T {
  const result = union.safeParse(value)
  if (result.success) return result.data
  const rendered = validationError('avantf-mem', result.error.issues) as { error: string; violations?: string[] }
  throw new Error([rendered.error, ...(rendered.violations ?? []).map((line) => `  ${line}`)].join('\n'))
}

function parseFlag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name)
  if (i === -1) return undefined
  const val = rest[i]
  // support --name value or --name=value
  if (val.includes('=')) return val.split('=')[1] ?? 'true'
  const next = rest[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}

/**
 * The ONE global flag: `--data-home <path>` / `--data-home=<path>`.
 *
 * Scanned across the WHOLE argv and REMOVED before dispatch, so it works before or after the command
 * and can never leak into a positional (`add --data-home /x 张伟` must write the fact `张伟`, not the
 * path). It is layer ⑤ of the data-root rule (explicit argument), so it outranks `AVANTF_HOME` while
 * leaving the FAMILY root alone — the point of the flag: pick a data home without also moving the
 * model/tools cache, which is what `AVANTF_HOME` does (see `LoadConfigOptions.managedRoots`).
 *
 * An omitted or blank value is a caller error, not "use the default": silently falling back is how a
 * shell expansion like `--data-home "$UNSET"` would write into `~/.avantf` while the operator believes
 * it wrote elsewhere. The same rule the base kit's `resolveDataHome` applies to its slots.
 */
function takeDataHome(argv: readonly string[]): { dataHome: string | undefined; argv: string[] } {
  const name = '--data-home'
  let dataHome: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token !== name && !token.startsWith(`${name}=`)) {
      rest.push(token)
      continue
    }
    // Inline form: everything after the first `=`.
    let value = token.startsWith(`${name}=`) ? token.slice(name.length + 1).trim() : undefined
    if (value === undefined) {
      const next = argv[i + 1]
      i++ // the next token is this flag's value, never a positional
      if (next === undefined || next.trim() === '' || next.startsWith('--')) {
        throw new Error(`${name} requires a path (e.g. ${name} ~/.avantf)`)
      }
      value = next.trim()
    }
    if (value === '') throw new Error(`${name} requires a non-empty path`)
    // Repeated occurrences: the last one wins, like every other single-valued flag here.
    dataHome = value
  }
  return { dataHome, argv: rest }
}

function posTokens(rest: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (!t.startsWith('--')) {
      out.push(t)
      continue
    }
    // a flag consumes its value so the value is not mistaken for a positional
    if (!t.includes('=') && rest[i + 1] && !rest[i + 1].startsWith('--')) i++
  }
  return out
}

function numFlag(rest: string[], name: string, allowZero = false): number | undefined {
  const raw = parseFlag(rest, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (allowZero) return Math.max(0, Math.trunc(n))
  return n > 0 ? n : undefined
}

/**
 * A flag whose value must be one of a closed set.
 *
 * Generic over the set's literal type, so the caller gets `'active' | 'archived'` back rather than a
 * `string` it has to cast — the sets themselves come from the contract (`FACT_STATUSES` and friends),
 * which is what stops this file from carrying a second copy of a value list that the tool schema, the
 * MCP inputSchema and the DSH parameter spec all derive from.
 */
function enumFlag<T extends string>(rest: string[], name: string, allowed: readonly T[]): T | undefined {
  const raw = parseFlag(rest, name)
  if (raw === undefined) return undefined
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of: ${allowed.join(' | ')} (got '${raw}')`)
  }
  return raw as T
}

/**
 * The one text-argument recall template: `search`/`ask` carry a `query`,
 * `probe`/`related` carry an `entity` — everything else (category, limit,
 * pretty-printed JSON) is identical.
 */
const RECALL_TEXT_CMDS: Record<string, { field: 'query' | 'entity'; category: boolean; budget?: boolean; usage: string }> = {
  // Only `search` takes an output budget in the contract, so only it advertises the flag.
  search: { field: 'query', category: true, budget: true, usage: 'usage: avantf-mem search <query> [--category X] [--limit N] [--max-tokens N]' },
  ask: { field: 'query', category: false, usage: 'usage: avantf-mem ask <question> [--limit N]' },
  probe: { field: 'entity', category: true, usage: 'usage: avantf-mem probe <entity> [--category X] [--limit N]' },
  related: { field: 'entity', category: true, usage: 'usage: avantf-mem related <entity> [--category X] [--limit N]' },
}

/**
 * Which commands touch the semantic path (query encode or vector indexing) and
 * therefore must await model warmup, as DATA.
 *
 * It used to be a `switch` beside `RECALL_TEXT_CMDS`, the main dispatch switch and the command
 * implementations — four independently maintained answers to "what does this command do", where a
 * command missing here means "the model was never warmed" (`ask` on a cold cache answers from the
 * degraded legs) and a local command listed here means a download for nothing. The rule per command
 * is now one table entry, and `mem/packages/core/test/cli_warmup.spec.ts` cross-checks the table
 * against the command list the usage banner advertises, so adding a command to the CLI fails the
 * suite until it is classified here.
 *
 *   - `always`      — the command encodes a query or writes vectors unconditionally;
 *   - `vectors-fix` — only the explicit repair loads the model (a plain `vectors` is a read);
 *   - `kb-write`    — only the three writing subcommands (`ingest` / `import` / `reindex`);
 *   - `write-unless-dry-run` — the command writes through the store (and so indexes) unless
 *                     `--dry-run` makes it a plan-only read; today `merge` and `import`;
 *   - absent        — pure DB/graph commands, so `list`/`show`/`stats`/`related`/`export` pay no download.
 *                     They load nothing either: the CLI builds the runtime with `deferWarm: true`, so
 *                     the adapters' constructor warm cannot fire behind this table's back.
 */
const COMMAND_MODEL_WARMUP: Readonly<Record<string, 'always' | 'vectors-fix' | 'kb-write' | 'write-unless-dry-run'>> = {
  add: 'always',
  edit: 'always',
  search: 'always',
  ask: 'always',
  probe: 'always',
  query: 'always',
  vectors: 'vectors-fix',
  kb: 'kb-write',
  merge: 'write-unless-dry-run',
  import: 'write-unless-dry-run',
}

/** {@link COMMAND_MODEL_WARMUP} applied: does THIS invocation need the embedding model? */
function needsModels(cmd: string | undefined, sub: string | undefined, rest: string[]): boolean {
  const rule = cmd === undefined ? undefined : COMMAND_MODEL_WARMUP[cmd]
  if (rule === 'always') return true
  if (rule === 'vectors-fix') return rest.includes('--fix')
  if (rule === 'kb-write') return sub === 'ingest' || sub === 'import' || sub === 'reindex'
  // `merge`/`import` write each imported fact through `rt.remember` (which indexes when the model
  // is up), while `--dry-run` is a plan-only read and must not pay for a download/warmup. `export`
  // is deliberately absent: it only reads rows that are already stored.
  if (rule === 'write-unless-dry-run') return !rest.includes('--dry-run')
  return false
}

/**
 * A `kb` write is REPLACE mode by default, and an unconfirmed collision writes NOTHING — the host
 * answers with a conflict report instead. The CLI must not print that as if the refresh happened,
 * so it fails the command with the reason. `--overwrite` is the explicit re-run (the UI gets the
 * same thing through its confirmation dialog).
 */
function assertNoKbConflict(result: unknown): void {
  if (result === null || typeof result !== 'object') return
  const record = result as { conflict?: unknown; error?: unknown }
  if (record.conflict !== true) return
  throw new Error(`${String(record.error ?? 'kb 写入冲突')}（确要覆盖请加 --overwrite）`)
}

/**
 * 方案 G: a recall/query result already carries `degraded`, but a bare JSON flag is easy to miss.
 * Print the matching sentence on STDERR — stdout stays pure JSON, so `avantf-mem search … | jq`
 * keeps working. No new field is invented; the flag alone decides.
 */
function printDegradedLegNote(result: unknown): void {
  if (result === null || typeof result !== 'object') return
  if ((result as { degraded?: unknown }).degraded !== true) return
  console.error(DEGRADED_LEG_NOTE)
}

/**
 * The one explicit codec flag: `--brotli`, `--gzip` or `--plain` (which means `none`, i.e. the
 * canonical minified JSON). At most one, because "compress AND don't compress" has no meaning.
 */
function exportCodecFlag(rest: string[]): FactsExportCodec | undefined {
  const chosen: FactsExportCodec[] = []
  if (rest.includes('--brotli')) chosen.push('brotli')
  if (rest.includes('--gzip')) chosen.push('gzip')
  if (rest.includes('--plain')) chosen.push('none')
  if (chosen.length > 1) throw new Error('--brotli / --gzip / --plain 只能给一个')
  return chosen[0]
}

async function main(): Promise<void> {
  // The global flag is pulled out FIRST, across the whole argv: it must not reach a positional and it
  // has to be known before the runtime (and therefore the data root) is built.
  const { dataHome, argv } = takeDataHome(process.argv.slice(2))
  const [cmd, ...rest] = argv
  const sub = rest[0]
  // `deferWarm: true` — the adapters must not warm in their constructor, because the CLI is one-shot
  // and a READ-ONLY command (`stats`, `list`, `export`, …) must not load — let alone download — the
  // model. Only `needsModels` below warms explicitly, and only for commands that actually encode.
  const rt = buildRuntime({ dataHome, deferWarm: true })
  try {
    // The CLI is one-shot: a command that encodes or searches semantically must
    // await warmup, or the process exits while the model is still loading.
    if (needsModels(cmd, sub, rest)) await warmModels(rt)

    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `avantf-mem
    // toString` would resolve Object.prototype.toString as if it were a command.
    if (cmd !== undefined && Object.hasOwn(RECALL_TEXT_CMDS, cmd)) {
      const spec = RECALL_TEXT_CMDS[cmd]
      const text = posTokens(rest).join(' ')
      if (!text) throw new Error(spec.usage)
      const req: Record<string, unknown> = { action: cmd, [spec.field]: text, limit: numFlag(rest, '--limit') }
      if (spec.category) req['category'] = parseFlag(rest, '--category')
      if (spec.budget === true) req['max_tokens'] = numFlag(rest, '--max-tokens', true) // 0 = no budget
      const result = await rt.recall(validated(RecallUnion, req))
      console.log(JSON.stringify(result, null, 2))
      printDegradedLegNote(result)
      return
    }

    switch (cmd) {
      // ─── memory ───────────────────────────────────────────────
      case 'add': {
        const content = posTokens(rest).join(' ')
        if (!content) throw new Error('usage: avantf-mem add <content> [--category X] [--ttl N]')
        const res = await rt.remember(validated(RememberUnion, { action: 'add', content, category: parseFlag(rest, '--category'), ttl_days: numFlag(rest, '--ttl', true) }))
        console.log(JSON.stringify(res))
        break
      }
      case 'reason': {
        const entities = posTokens(rest)
        if (entities.length < 1) throw new Error('usage: avantf-mem reason <entity1> [entity2 ...] [--limit N]')
        console.log(JSON.stringify(await rt.recall(validated(RecallUnion, { action: 'reason', entities, limit: numFlag(rest, '--limit') })), null, 2))
        break
      }
      case 'chain': {
        const subj = posTokens(rest)[0]
        if (!subj) throw new Error('usage: avantf-mem chain <subj> [--pred X] [--second-pred Y] [--limit N]')
        console.log(JSON.stringify(await rt.recall(validated(RecallUnion, {
          action: 'chain',
          subj,
          pred: parseFlag(rest, '--pred'),
          second_pred: parseFlag(rest, '--second-pred'),
          limit: numFlag(rest, '--limit'),
        })), null, 2))
        break
      }
      case 'list': {
        const status = enumFlag(rest, '--status', FACT_STATUSES) ?? 'active'
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, {
          action: 'list',
          status,
          limit: numFlag(rest, '--limit'),
          offset: numFlag(rest, '--offset', true),
        })), null, 2))
        break
      }
      case 'show': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(rt.memory.get(fid), null, 2))
        break
      }
      case 'edit': {
        const args = posTokens(rest)
        const fid = Number(args[0])
        const content = args.slice(1).join(' ')
        if (!fid || !content) throw new Error('usage: avantf-mem edit <fact_id> <new content> [--category X] [--ttl N]')
        console.log(JSON.stringify(await rt.remember(validated(RememberUnion, {
          action: 'update',
          fact_id: fid,
          content,
          category: parseFlag(rest, '--category'),
          ttl_days: numFlag(rest, '--ttl', true),
        }))))
        break
      }
      case 'remove': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(await rt.remember(validated(RememberUnion, { action: 'remove', fact_id: fid, reason: parseFlag(rest, '--reason') }))))
        break
      }
      case 'archive': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, { action: 'archive', fact_id: fid, reason: parseFlag(rest, '--reason') }))))
        break
      }
      case 'restore': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, { action: 'restore', fact_id: fid }))))
        break
      }
      case 'helpful': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(await rt.remember(validated(RememberUnion, { action: 'helpful', fact_id: fid }))))
        break
      }
      case 'unhelpful': {
        const fid = Number(posTokens(rest)[0])
        console.log(JSON.stringify(await rt.remember(validated(RememberUnion, { action: 'unhelpful', fact_id: fid }))))
        break
      }
      case 'stats':
        console.log(JSON.stringify(rt.admin({ action: 'stats' }), null, 2))
        break
      case 'contradict':
        console.log(JSON.stringify(rt.admin({ action: 'contradict_check' }), null, 2))
        break
      case 'resolve': {
        const cid = Number(posTokens(rest)[0])
        // No id → list what is open, ids included: `contradict` runs the sweep and reports pairs,
        // and the id it does not return is exactly what a verdict needs.
        if (!Number.isFinite(cid)) {
          console.log(JSON.stringify(await rt.recall(validated(RecallUnion, { action: 'contradict', limit: 50 })), null, 2))
          break
        }
        const resolution = enumFlag(rest, '--resolution', CONTRADICTION_RESOLUTIONS) ?? 'true_positive'
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, {
          action: 'contradict_resolve',
          contradiction_id: cid,
          resolution,
          loser_fact_id: numFlag(rest, '--loser'),
        })), null, 2))
        break
      }
      case 'merge': {
        // Content-identity union with another host's memory.db. The source is opened READ ONLY (the
        // command never migrates or writes it); the target is *this* runtime, and every imported
        // fact goes through `rt.remember` so vectors/entities/provenance are generated normally. The
        // loop itself lives in @avantf/mem, shared with `import` (one add path, one failure rule).
        const sourcePath = posTokens(rest)[0]
        if (!sourcePath) throw new Error('usage: avantf-mem merge <path-to-other-memory.db> [--dry-run] [--source-ref <text>]')
        const report = await mergeDb(rt, sourcePath, {
          sourceRef: parseFlag(rest, '--source-ref'),
          dryRun: rest.includes('--dry-run'),
        })
        console.log(JSON.stringify(report, null, 2))
        break
      }
      case 'export': {
        // Read-only snapshot of THIS host's facts. No model warmup: nothing here encodes a query.
        const status = enumFlag(rest, '--status', EXPORT_STATUSES) ?? 'all'
        const out = parseFlag(rest, '--out')
        if (out === 'true') {
          throw new Error('usage: avantf-mem export [--out <file>] [--status active|archived|all] [--brotli|--gzip|--plain]')
        }
        const explicitCodec = exportCodecFlag(rest)
        const doc = exportFacts(rt, { status })
        if (out === undefined) {
          // Without --out the DOCUMENT ITSELF is stdout (not a wrapper) and stays UNCOMPRESSED: it can
          // be piped straight into `import -`, `jq`, or a backup file. Compression is a file
          // decision, so asking for a codec without --out is a usage error rather than a silent
          // change of what stdout means.
          if (explicitCodec !== undefined) {
            throw new Error('--brotli / --gzip / --plain 需要配合 --out：stdout 始终是明文 minified JSON（可直接管道给 import -）')
          }
          process.stdout.write(serializeFactsExport(doc) + '\n')
          break
        }
        const outPath = resolve(out)
        // Explicit flag → extension (.br / .gz) → plain minified JSON. The rule lives in the engine
        // (`codecForExportPath`) because /mem must apply the same one.
        const codec = codecForExportPath(outPath, explicitCodec)
        const bytes = encodeFactsExport(doc, { codec })
        const plainBytes = encodeFactsExport(doc, { codec: 'none' }).length
        writeFileSync(outPath, bytes)
        console.log(JSON.stringify({
          out: outPath,
          codec,
          bytes: bytes.length,
          plain_bytes: plainBytes,
          // bytes ÷ the uncompressed minified size. 1 for --plain, < 1 for a compressed file.
          ratio: plainBytes === 0 ? 0 : Number((bytes.length / plainBytes).toFixed(3)),
          counts: doc.source.counts,
        }, null, 2))
        break
      }
      case 'import': {
        // Content-identity union from an export document: the file/stdin variant of `merge`. A broken
        // format/version throws BEFORE any write; a single refused fact is collected by importFacts
        // and the rest continue.
        //
        // A FILE is read as BYTES and sniffed (plain JSON / gzip / brotli, by content, never by
        // extension); stdin stays TEXT, because that is what `export` wrote into the pipe.
        const file = posTokens(rest)[0]
        if (!file) throw new Error('usage: avantf-mem import <file|-> [--dry-run] [--source-ref <text>]')
        const doc = file === '-'
          ? parseFactsExport(readStdin())
          : decodeFactsExport(readFileSync(file)).doc
        const explicitRef = parseFlag(rest, '--source-ref')
        if (explicitRef === '') throw new Error('--source-ref 不能为空')
        // Provenance fallback only: a fact that carries `sources[0].ref` keeps it (importFacts).
        const sourceRef = explicitRef ?? ('import:' + (file === '-' ? 'stdin' : basename(file)))
        const report = await importFacts(rt, doc, { dryRun: rest.includes('--dry-run'), sourceRef })
        console.log(JSON.stringify({ file, ...report }, null, 2))
        break
      }
      case 'maintenance': {
        // `maintenance` runs the lifecycle pass plus ONE bounded derived-state sweep (it must stay
        // bounded: the settings page and the MCP tool call the same thing). The CLI is the surface
        // that can afford to finish the job, so it drains the remainder in batches — never in one
        // pass, which would read every stale fact's text into memory before rebuilding the first.
        const result = await rt.admin({ action: 'maintenance' })
        let rebuilt = result.entities.rebuilt
        let deferred = result.entities.deferred
        while (deferred > 0) {
          const pass = await rt.memory.reindexEntities(ENTITY_SWEEP_BATCH)
          if (pass.rebuilt === 0) break // no progress (or another sweep holds the guard)
          rebuilt += pass.rebuilt
          deferred = pass.deferred
        }
        // Same shape for the CONFLICT queue: `maintenance` drained one bounded batch (the settings
        // page and the MCP tool must stay a click) and the CLI finishes the remainder. A row whose
        // vector the live index cannot serve is never "checked", so the loop stops on a pass that
        // completed nothing instead of spinning on it.
        let conflicts = result.conflicts
        for (;;) {
          if (conflicts.pending === 0) break
          const pass = rt.memory.drainConflicts()
          if (pass.checked === 0) break
          conflicts = {
            checked: conflicts.checked + pass.checked,
            logged: conflicts.logged + pass.logged.length,
            pending: pass.pending,
          }
        }
        console.log(JSON.stringify({
          ...result,
          entities: { rebuilt, deferred, skipped: result.entities.skipped },
          conflicts,
        }, null, 2))
        break
      }
      case 'trust':
        console.log(JSON.stringify(rt.admin({ action: 'trust_diagnose' }), null, 2))
        break
      case 'pin': {
        const fid = Number(posTokens(rest)[0])
        if (!fid) throw new Error('usage: avantf-mem pin <fact_id>')
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, { action: 'pin', fact_id: fid }))))
        break
      }
      case 'unpin': {
        const fid = Number(posTokens(rest)[0])
        if (!fid) throw new Error('usage: avantf-mem unpin <fact_id>')
        console.log(JSON.stringify(rt.admin(validated(AdminUnion, { action: 'unpin', fact_id: fid }))))
        break
      }
      case 'vectors': {
        const fix = rest.includes('--fix')
        // `--store memory|knowledge` narrows the repair to one library; omitted = both (the report is
        // per store either way).
        const store = parseFlag(rest, '--store')
        const result = fix
          ? await rt.admin(validated(AdminUnion, {
              action: 'vectors_fix',
              dry_run: rest.includes('--dry-run'),
              ...(store === undefined ? {} : { store }),
            }))
          : rt.admin(validated(AdminUnion, { action: 'vectors_diagnose' }))
        console.log(JSON.stringify(result, null, 2))
        break
      }

      // ─── knowledge ────────────────────────────────────────────
      case 'kb': {
        const kbRest = rest.slice(1)
        switch (sub) {
          case 'ingest': {
            const uri = parseFlag(kbRest, '--uri') ?? parseFlag(kbRest, '--source-uri')
            const args = posTokens(kbRest)
            const domain = parseFlag(kbRest, '--domain')
            // `--source` is optional: the contract's default is the same value (`DEFAULT_KB_SOURCE`).
            const source = parseFlag(kbRest, '--source') || DEFAULT_KB_SOURCE
            // Explicit confirmation to replace a colliding document (URL re-fetch included).
            const overwrite = kbRest.includes('--overwrite') ? true : undefined
            if (!domain) throw new Error('kb ingest requires --domain')
            if (uri) {
              const result = await rt.kb(validated(KbUnion, { action: 'ingest', source_uri: uri, domain, source, title: args[0], overwrite }))
              assertNoKbConflict(result)
              console.log(JSON.stringify(result))
              break
            }
            const text = args.join(' ') || readStdin()
            if (!text) throw new Error('kb ingest requires text (positional or stdin) or --uri <path|url>')
            const result = await rt.kb(validated(KbUnion, { action: 'ingest', text, domain, source, overwrite }))
            assertNoKbConflict(result)
            console.log(JSON.stringify(result))
            break
          }
          case 'import': {
            const paths = posTokens(kbRest)
            const domain = parseFlag(kbRest, '--domain')
            const source = parseFlag(kbRest, '--source') || DEFAULT_KB_SOURCE
            const overwrite = kbRest.includes('--overwrite') ? true : undefined
            if (!paths.length || !domain) throw new Error('kb import requires paths and --domain')
            const result = await rt.kb(validated(KbUnion, { action: 'import', paths, domain, source, overwrite }))
            assertNoKbConflict(result)
            console.log(JSON.stringify(result))
            break
          }
          case 'list':
            console.log(JSON.stringify(await rt.kb(validated(KbUnion, { action: 'list', domain: parseFlag(kbRest, '--domain'), source: parseFlag(kbRest, '--source') })), null, 2))
            break
          case 'detail': {
            const doc = Number(posTokens(kbRest)[0])
            console.log(JSON.stringify(await rt.kb(validated(KbUnion, { action: 'detail', doc_id: doc })), null, 2))
            break
          }
          case 'remove': {
            const doc = Number(posTokens(kbRest)[0])
            console.log(JSON.stringify(await rt.kb(validated(KbUnion, { action: 'remove', doc_id: doc }))))
            break
          }
          case 'reindex':
            console.log(JSON.stringify(await rt.kb(validated(KbUnion, {
              action: 'reindex',
              domain: parseFlag(kbRest, '--domain'),
              dry_run: kbRest.includes('--dry-run') ? true : undefined,
            })), null, 2))
            break
          case 'sync':
            // Re-ingest every managed file that changed since it was ingested (or just one document).
            console.log(JSON.stringify(await rt.kb(validated(KbUnion, {
              action: 'sync',
              doc_id: posTokens(kbRest)[0] === undefined ? undefined : Number(posTokens(kbRest)[0]),
              dry_run: kbRest.includes('--dry-run') ? true : undefined,
            })), null, 2))
            break
          default:
            console.log('kb subcommands: ingest | import | list | detail | remove | reindex | sync')
        }
        break
      }

      // ─── cross query ─────────────────────────────────────────
      case 'query': {
        const q = posTokens(rest).join(' ')
        if (!q) throw new Error('usage: avantf-mem query <q> [--kind fact|doc_chunk|all] [--domain X] [--source Y] [--limit N]')
        const kind = enumFlag(rest, '--kind', QUERY_KINDS)
        const result = await rt.query(validated(QueryUnion, {
          query: q,
          kind,
          domain: parseFlag(rest, '--domain'),
          source: parseFlag(rest, '--source'),
          limit: numFlag(rest, '--limit') ?? 10,
          max_tokens: numFlag(rest, '--max-tokens', true), // 0 = no budget
        }))
        console.log(JSON.stringify(result, null, 2))
        printDegradedLegNote(result)
        break
      }

      default:
        console.log('usage: avantf-mem <add|search|ask|probe|related|reason|chain|list|show|edit|remove|archive|restore|helpful|unhelpful|stats|contradict|merge|export|import|resolve [<id>]|maintenance|trust|pin|unpin|vectors|kb <sub>|query>')
        console.log('global: --data-home <path> — data root for this invocation (layer ⑤, outranks AVANTF_HOME); the model/tools family root is NOT moved')
    }
  } finally {
    rt.shutdown()
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8').trim()
  } catch {
    return ''
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exitCode = 1
})
