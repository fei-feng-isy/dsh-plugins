import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isSeq, parseDocument } from 'yaml'

/**
 * Append one 知识域 to the STORE config's top-level `domains` allowlist
 * (`~/.avantf/configs/knowledge.yaml`, layer ③ of `loader.ts`) and return the new list.
 *
 * This is the write half of the UI-only `kbAddDomain` path, so the user adds a domain once in the
 * 知识 tab instead of hand-editing YAML. It writes to the STORE config rather than the common one:
 * `knowledge.domains` is resolved from layer ③ (the file the loader parses with
 * `KnowledgeConfigSchema`), and a second source of truth would make "where do I change it?" a
 * question again.
 *
 * `parseDocument` + `toString` (never `parse`/`stringify`): the comments in that file are the
 * documentation for the keys around them, and a round-trip that drops them quietly turns a
 * documented config into a bare list. When `domains` is already a sequence the node is mutated IN
 * PLACE (`seq.add`), which keeps the comments attached to the key and its items; a missing key is
 * created.
 *
 * The write is temp file + atomic rename, the same shape as the managed document copy
 * (`doc_files.ts`): a crash mid-write must not leave a truncated config the next boot cannot parse.
 */
export function addKnowledgeDomain(configPath: string, domain: string): string[] {
  const doc = parseDocument(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '')
  const node = doc.get('domains')
  const current = isSeq(node) ? node.toJSON() : undefined
  const list: string[] = Array.isArray(current) ? current.map(value => String(value)) : []
  if (list.includes(domain)) return list
  if (isSeq(node)) node.add(domain)
  else doc.set('domains', [...list, domain])
  mkdirSync(dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp-${String(process.pid)}`
  writeFileSync(tmp, doc.toString(), 'utf8')
  renameSync(tmp, configPath)
  return [...list, domain]
}
