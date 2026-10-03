/**
 * Durable layout for the mission tree: one record per tree, opened once per process
 * (`storage-domain` refuses a second open), which is why the plugin owns the handle.
 * @module @avantf/dsh-mission/domain
 */
// Namespace import, not `import { z }`: the zod entry re-exports `locales` as a namespace, and a
// named import of `z` makes esbuild materialise that whole namespace into the browser bundle
// (64 locale files, ~264 KB minified). The namespace form lets the locales be tree-shaken; the
// schemas and wire shapes are byte-for-byte unchanged.
import * as z from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { TreeDocument as TreeDocumentShape } from '@avantf/mission-core'

/** Domain name; doubles as the backend unit name and must match `UNIT_NAME_RE`. */
const DOMAIN_NAME = 'avantf_mission'

/**
 * Layout version. **Stays 1 while the schema only gains optional-with-default fields**: the
 * `single` layout compares the stamp for exact equality and throws `version-mismatch` on any
 * bump, a failed open that bricks every existing installation. Bump only for a non-backward-
 * readable change, and move to `layout: 'per-record'` in the same change so `compatibleVersions` applies.
 */
export const DOMAIN_VERSION = 1

export const TREES_TABLE = 'trees'

/**
 * The dispatch baseline: what a prompt showed its session, so a later cold wake can subtract it.
 * Every member is required — a partially-written baseline is not a weaker snapshot, it is a wrong
 * one, and the consumer (`continuation.ts`) reads a malformed object as "no baseline" rather than
 * trusting invented numbers. The one deliberate exception is `holder`, added after the shape shipped:
 * a missing holder means "author unknown", which the delta handles with its own conservative
 * fallback, so it carries a default instead of invalidating five members that are still exact.
 */
const baselineSchema = z.object({
  corrections: z.number(),
  notes: z.number(),
  terminalChildren: z.number(),
  fingerprint: z.string(),
  attempts: z.number(),
  // Optional-with-default, NOT required: a baseline written before the field existed still has five
  // trustworthy members, and `null` (= "holder unknown") is exactly the fallback the delta wants —
  // dropping the whole baseline would turn a one-field migration into a permanent loss of context.
  holder: z.string().nullable().default(null).catch(null),
})

/**
 * The node and tree schemas, exported so the cross-layer default pin
 * (`test/domain_defaults_pin.spec.ts`) can enumerate EVERY field this module defaults, instead of
 * the pin hard-coding a list that would go stale the moment a field is added.
 */
export const nodeSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  // Optional-with-default: a document written before the field existed must keep loading, and it
  // reads as "no scope declared" — the value that takes no part in the engine's unit leases, i.e.
  // exactly today's behaviour. `.catch(null)` covers the other direction: a value that is not a
  // string (a hand-edited number) degrades to "no scope" rather than failing the whole document
  // open, because an invented scope would serialize a mission against a resource nobody named.
  unit: z.string().nullable().default(null).catch(null),
  // Optional-with-default: a document written before the field existed reads as the default 1 (the
  // ordinary slot), and `.catch(1)` degrades a dirty value to it too. A dirty weight must never make
  // a node invisible to the capacity gate, so the fallback is the conservative one — a full slot.
  weight: z.number().default(1).catch(1),
  // Optional-with-default: a document written before the round-cap declaration existed reads as
  // `null` = the engine's configured cap, i.e. exactly the previous behaviour. `.catch(null)` degrades
  // a dirty value to it too, because an unbounded or nonsensical declaration must never relax the
  // backstop that catches a transport retrying forever.
  roundMs: z.number().nullable().default(null).catch(null),
  context: z.array(z.string()),
  // Optional-with-default: a document written before the field existed must keep loading.
  corrections: z.array(z.string()).default([]),
  // Optional-with-default, and the default is the CONSERVATIVE one: a missing watermark reads as
  // "nothing has been delivered", so a wake still carries every correction rather than silently
  // skipping a direction the owner gave.
  correctionsDeliveredUpTo: z.number().default(0),
  analysisNotes: z.array(z.string()).default([]),
  analysisAttempt: z.number().default(0),
  // Optional-with-default: a document written before note authorship existed reads as "author
  // unknown", which sends the cold wake's material judgement down its generation-comparison fallback
  // — the previous build's behaviour, never a fabricated "somebody else wrote this".
  analysisAuthor: z.string().nullable().default(null).catch(null),
  status: z.enum(['blocked', 'ready', 'running', 'interrupted', 'done', 'failed']),
  createdAt: z.number(),
  depth: z.number(),
  claimedBy: z.string().nullable(),
  claimedAt: z.number(),
  attempts: z.number(),
  failures: z.number().default(0),
  spawnFailures: z.number().default(0),
  parkedWorker: z.string().nullable().default(null),
  // Optional-with-default: a document written before the field existed reads as "no continuation
  // handle", which is the only safe default — an invented session id would be woken.
  lastWorkerId: z.string().nullable().default(null),
  // Optional-with-default: a document written before the field existed reads as "no executor to
  // open". This is a DISPLAY address (kept after a node ends), so the conservative default is the
  // one that offers no link; `.catch(null)` degrades a non-string the same way rather than failing
  // the whole document open over a field that only decides whether a link is rendered.
  executorSessionId: z.string().nullable().default(null).catch(null),
  // Optional-with-default, and the default is UNKNOWN rather than "nothing changed": a wake that
  // cannot subtract a baseline renders an honest caveat instead of pretending the mission is
  // unchanged. `.catch(null)` covers the other direction — a baseline object that fails to parse
  // must degrade to "unknown" too, never to a half-read snapshot the delta would believe.
  dispatchBaseline: baselineSchema.nullable().default(null).catch(null),
  // Optional-with-default: reads as "no activity observed, never stalled, never reported".
  progressAt: z.number().default(0),
  // Optional-with-default: a document written before the field existed reads as "no event was ever
  // observed", which the liveness readers treat as "cannot tell output from noise" and fall back to
  // `progressAt` — i.e. the previous build's judgement, plus the new round cap. 0 is the only safe
  // default: an invented timestamp could make a hung node look productive.
  activityAt: z.number().default(0),
  stalls: z.number().default(0),
  // Optional-with-default: a document written before the hang streak existed reads as "no consecutive
  // hangs". `.catch(0)` degrades a dirty value the same way — an invented streak would page the owner
  // about a node that never hung.
  hungCount: z.number().default(0).catch(0),
  stalledNotifiedAt: z.number().nullable().default(null),
  result: z.string().nullable(),
  hasResult: z.boolean(),
  resultReadAt: z.number().nullable(),
  resultRef: z.string().nullable(),
  resultHint: z.string().nullable().default(null),
  children: z.array(z.string()),
  updatedAt: z.number(),
})

export const treeSchema = z.object({
  rootId: z.string(),
  ownerSessionId: z.string(),
  createdAt: z.number(),
  // Optional-with-default: a document written before the field existed reads as open.
  closedAt: z.number().nullable().default(null),
  // Optional-with-default: reads as "never reported", so a terminal tree is told twice, not never.
  reportedAt: z.number().nullable().default(null),
})

export const treeDocumentSchema: z.ZodType<TreeDocumentShape> = z.object({
  tree: treeSchema,
  nodes: z.record(z.string(), nodeSchema),
})

export type TreeDocument = TreeDocumentShape

export const workDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  // No `compatibleVersions`: it applies only to `per-record`; readability here comes from the
  // optional-with-default fields instead.
  tables: {
    [TREES_TABLE]: domainTable<string, TreeDocument>(treeDocumentSchema),
  },
})
