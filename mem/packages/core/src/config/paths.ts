import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Config } from '@avantf/mem-contract'
import { expandHome } from '@avantf/mem-contract'

/** Expand a leading `~/` to the user home directory — single source in the contract. */
export { expandHome }

/**
 * Resolve the data home (default `~/.avantf`).
 *
 * Precedence, per DESIGN §3 and `mem/AGENTS.md`'s layering (built-in → common.yaml → store → ENV →
 * explicit): an EXPLICIT caller value (⑤) → `AVANTF_HOME` (④) → the configured `common.dataHome`
 * (②) → `~/.avantf`. The environment is a deployment override and outranks the config file.
 *
 * `configured` cannot stand in for layer ⑤: the schema gives it a default, so it always holds a
 * value and would make an explicit argument indistinguishable from "nothing was configured" — which
 * is exactly how the env var used to win over a caller's own `dataHome`.
 *
 * The slots are NAMED for the same reason the base kit's copy is: the two implementations used to
 * disagree about their POSITIONAL order (`(explicit, env, common)` here, `(common, explicit)`…
 * whichever way a reader guessed), so "which slot does the profile's `dataHome` belong in?" was
 * answerable only by reading the call site. The base kit implements the same rule with the same named
 * shape, and `packages/plugin/test/family_pin.spec.ts` pins the two implementations together.
 */
export function resolveDataHome(input: {
  /** Layer ②: the configured `common.dataHome`. */
  readonly common: Pick<Config, 'dataHome'>
  /** Layer ⑤: an explicit caller value (the CLI's `--data-home`). */
  readonly explicit?: string
}): string {
  // Blank is UNSET in every slot, exactly as the base kit treats it. Without the trim a configured
  // value of spaces won the layer and came back as the RELATIVE path `'   '` — data written under
  // whatever directory the process started in. That is the divergence this pair of copies is pinned
  // against (`packages/plugin/test/family_pin.spec.ts` carries the whitespace cases), and it is why
  // the trim lives here rather than only in the caller.
  const layer5 = input.explicit?.trim() ?? ''
  const fromEnv = process.env['AVANTF_HOME']?.trim() ?? ''
  const layer2 = input.common.dataHome?.trim() ?? ''
  const base = layer5 !== '' ? layer5 : fromEnv !== '' ? fromEnv : layer2 !== '' ? layer2 : '~/.avantf'
  return expandHome(base)
}

/**
 * Every config file lives in ONE directory, beside the prompt files.
 *
 * The layering is unchanged (① built-in → ② common → ③ store → ④ env → ⑤ explicit); only the
 * locations moved, so all of a deployment's editable text — `configs/*.yaml` and `prompts/*.md` —
 * is in one place instead of scattered through `memory/` and `knowledge/` next to the databases.
 */
export function configsDir(home: string): string {
  return join(home, 'configs')
}
export function commonConfigPath(home: string): string {
  return join(configsDir(home), 'common.yaml')
}
export function memoryDir(home: string): string {
  return join(home, 'memory')
}
export function knowledgeDir(home: string): string {
  return join(home, 'knowledge')
}
export function memoryConfigPath(home: string): string {
  return join(configsDir(home), 'memory.yaml')
}
export function knowledgeConfigPath(home: string): string {
  return join(configsDir(home), 'knowledge.yaml')
}
export function memoryDbPath(home: string, override?: string): string {
  const fromEnv = process.env['AVANTF_MEM_DB']
  return override || fromEnv || join(memoryDir(home), 'memory.db')
}
export function knowledgeDbPath(home: string, override?: string): string {
  const fromEnv = process.env['AVANTF_KNOWLEDGE_DB']
  return override || fromEnv || join(knowledgeDir(home), 'knowledge.db')
}

/**
 * The managed document directory (default `<home>/knowledge/docs`).
 *
 * One editable `.md` per document, so the corpus can be maintained with ordinary tools. It sits
 * BESIDE the database rather than replacing it: the file holds the body, the database holds the
 * identity, chunks and indexes derived from it.
 */
export function knowledgeDocsDir(home: string, override?: string): string {
  const fromEnv = process.env['AVANTF_KNOWLEDGE_DOCS']
  return override || fromEnv || join(knowledgeDir(home), 'docs')
}

/** Ensure the memory/knowledge layout exists under `home`. */
export function ensureDataLayout(home: string): void {
  mkdirSync(memoryDir(home), { recursive: true })
  mkdirSync(knowledgeDir(home), { recursive: true })
  mkdirSync(configsDir(home), { recursive: true })
}
