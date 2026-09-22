/**
 * Spec helper: open the knowledge domain allowlist for the fixtures' own taxonomy names.
 *
 * The shipped default `knowledge.domains` is a small general allowlist (DESIGN §8), and a store
 * refuses a NEW domain outside it. Specs use names of their own (`tech`, `a:b`, `os`, …), so they
 * write the documented "empty = no restriction" value into `<home>/configs/knowledge.yaml` rather
 * than widening the product default to fit a test.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function allowAnyDomain(home: string, extraYaml = ''): void {
  mkdirSync(join(home, 'configs'), { recursive: true })
  writeFileSync(join(home, 'configs', 'knowledge.yaml'), `domains: []\n${extraYaml}`)
}
