/**
 * Durable layout for the mission tree: one record per tree, opened once per process
 * (`storage-domain` refuses a second open), which is why the plugin owns the handle.
 * @module @avantf/dsh-mission/domain
 */
import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { TreeDocument as TreeDocumentShape } from '@avantf/mission-core'

/** Domain name; doubles as the backend unit name and must match `UNIT_NAME_RE`. */
export const DOMAIN_NAME = 'avantf_mission'

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
 * trusting invented numbers.
 */
const baselineSchema = z.object({
  corrections: z.number(),
  notes: z.number(),
  terminalChildren: z.number(),
  fingerprint: z.string(),
  attempts: z.number(),
})

const nodeSchema = z.object({
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
  context: z.array(z.string()),
  // Optional-with-default: a document written before the field existed must keep loading.
  corrections: z.array(z.string()).default([]),
  // Optional-with-default, and the default is the CONSERVATIVE one: a missing watermark reads as
  // "nothing has been delivered", so a wake still carries every correction rather than silently
  // skipping a direction the owner gave.
  correctionsDeliveredUpTo: z.number().default(0),
  analysisNotes: z.array(z.string()).default([]),
  analysisAttempt: z.number().default(0),
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
  // Optional-with-default, and the default is UNKNOWN rather than "nothing changed": a wake that
  // cannot subtract a baseline renders an honest caveat instead of pretending the mission is
  // unchanged. `.catch(null)` covers the other direction — a baseline object that fails to parse
  // must degrade to "unknown" too, never to a half-read snapshot the delta would believe.
  dispatchBaseline: baselineSchema.nullable().default(null).catch(null),
  // Optional-with-default: reads as "no activity observed, never stalled, never reported".
  progressAt: z.number().default(0),
  stalls: z.number().default(0),
  stalledNotifiedAt: z.number().nullable().default(null),
  result: z.string().nullable(),
  hasResult: z.boolean(),
  resultReadAt: z.number().nullable(),
  resultRef: z.string().nullable(),
  resultHint: z.string().nullable().default(null),
  children: z.array(z.string()),
  updatedAt: z.number(),
})

const treeSchema = z.object({
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
