import { ENTITY_SWEEP_BATCH, buildRuntime, warmModels } from '@avantf/mem'
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
import { readFileSync } from 'node:fs'

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
 * therefore must await model warmup. Pure DB/graph commands skip it, so
 * `list`/`show`/`stats` never pay a model download.
 */
function needsModels(cmd: string | undefined, sub: string | undefined, rest: string[]): boolean {
  switch (cmd) {
    case 'add':
    case 'edit':
    case 'search':
    case 'ask':
    case 'probe':
    case 'query':
      return true
    case 'vectors':
      return rest.includes('--fix')
    case 'kb':
      return sub === 'ingest' || sub === 'import' || sub === 'reindex'
    default:
      return false
  }
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

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  const sub = rest[0]
  const rt = buildRuntime()
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
        console.log('usage: avantf-mem <add|search|ask|probe|related|reason|chain|list|show|edit|remove|archive|restore|helpful|unhelpful|stats|contradict|resolve [<id>]|maintenance|trust|pin|unpin|vectors|kb <sub>|query>')
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
