#!/usr/bin/env node
/**
 * DSH real-Cordis mount smoke for @avantf/dsh-mem (DSH-standard plugin form).
 *
 * Loads the host plugin in an actual `@deepseek-ai/cordis` Context and asserts it
 * provides the `avantfMemory` service, registers the 5 model tools via the `tools`
 * service (`ctx.tools.register`), and exposes the `avantfMem` Typert Remote gateway.
 *
 * The plugin's `@deepseek-ai/*` peers come from the INSTALLED global dsh (`npm root -g`), whose
 * transitive deps are not all standalone-published. Build the plugin first:
 *
 *   pnpm build:dsh
 *
 * Requires env:
 *   - AVANTFMEM  : path to this repo (default: the repo root)
 *
 * No harness source checkout is involved: the peers are the same package instances a live profile
 * loads, so the mount proves the combination that actually runs.
 *
 * A second mode verifies the PACKED artifact instead of the workspace — the
 * surface a user actually installs (`pnpm pack:plugin --mount`), where the
 * engine is inlined and the only `@avantf/*` package on disk is the base PEER:
 *   - AVANTF_PLUGIN_DIR   : the plugin package directory to import (extracted tarball)
 *   - AVANTF_MOUNT_SCRATCH: a prepared profile dir: `node_modules/@avantf/dsh-mem`
 *                           plus the plugin's runtime externals, the base peer and
 *                           the harness peers. Both set together; the smoke then
 *                           links nothing and only cleans up its own data home.
 * In that mode a leaked ENGINE `@avantf/*` import cannot resolve, so the mount
 * itself is the assertion that the package is self-contained.
 *
 * Two startup profiles, chosen by env (both matter to the base path):
 *   - normal              : `@avantf/dsh-plugin-base` is resolvable (the workspace link, or a packed
 *                           profile that linked it). The base ARRIVES WITH its compatibility gate, so
 *                           the gate runs straight off it (`compat: ok`) — nothing is seeded and
 *                           nothing is downloaded. Both download switches are forced off, so
 *                           `mem:model` settles `skipped (policy/download-disabled)` without any
 *                           network — the engine then warms a LOCAL model only.
 *   - AVANTF_ENVINIT_ABSENT=1: the caller made the base unresolvable — the plugin must warn and fall
 *                           back to the legacy `provision:` sweep, and still mount in full.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedDshDir } from '../../scripts/lib/harness-path.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One-line reason for a caught value.
 *
 * Defined HERE, not imported: every `FAILED (${describeError(error)})` line runs only when something
 * else already failed, so an undefined identifier there replaces the whole summary with a
 * `ReferenceError` and hides the real cause. That is exactly what happened while releasing 0.1.1 —
 * a missing `better-sqlite3` binding (the release tree had not built its native deps) surfaced as
 * `describeError is not defined`, which cost a diagnosis round.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Packed-artifact mode: the caller prepared the profile dir, so link nothing here. */
const packagedDir = process.env['AVANTF_PLUGIN_DIR']
const preparedScratch = process.env['AVANTF_MOUNT_SCRATCH']
const pluginDir = packagedDir ?? join(repo, 'packages', 'plugin')
const scratch = preparedScratch ?? mkdtempSync(join(tmpdir(), 'avf-mount-'))
const ownsScratch = preparedScratch === undefined
if (packagedDir === undefined) {
  /** The directory holding the peer packages: `<installed dsh>/node_modules/@deepseek-ai`. */
  const dshDir = installedDshDir()
  const peersRoot = dshDir === undefined ? undefined : join(dshDir, 'node_modules', '@deepseek-ai')
  if (peersRoot === undefined || !existsSync(peersRoot)) {
    console.error(`mount-smoke: the installed dsh peers were not found${peersRoot === undefined ? '' : ` at ${peersRoot}`}`)
    console.error('  install it first: npm i -g @deepseek-ai/dsh')
    process.exit(1)
  }
  mkdirSync(join(scratch, 'node_modules', '@avantf'), { recursive: true })
  mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const [name, dir] of [
    ['mem', 'packages/core'],
    ['mem-retrieval', 'packages/retrieval-core'],
    ['mem-contract', 'packages/contract'],
    ['dsh-mem', 'packages/plugin'],
  ]) symlinkSync(join(repo, dir), join(scratch, 'node_modules', '@avantf', name))
  // DSH packages the standard plugin imports. Not linked: `dsh-system-prompt` — the plugin imports
  // it TYPE-only (the `Context` augmentation), and its runtime surface (`ctx.systemPrompt.section`)
  // is the stub provided below.
  for (const name of ['cordis', 'schemastery', 'dsh-tools', 'dsh-typert-protocol', 'dsh-util-values']) {
    symlinkSync(join(peersRoot, name), join(scratch, 'node_modules', '@deepseek-ai', name))
  }
}

/** The family base: it is BOTH the environment framework and the compatibility gate now. */
const FRAMEWORK_PACKAGE = '@avantf/dsh-plugin-base'

/**
 * The base the plugin's own tree resolves — the same resolution the inlined bootstrap performs
 * (`createRequire` from the plugin entry). `undefined` when the caller deliberately linked nothing
 * (the packed "base unresolvable" profile) or the base is not installed.
 *
 * There is nothing to seed any more: the base IS the gate, so a resolvable base means the gate runs
 * straight off it. This only answers "can the bootstrap find it at all".
 */
const pluginRequire = createRequire(join(pluginDir, 'lib', 'index.js'))
function resolveBaseDir() {
  try {
    return dirname(pluginRequire.resolve(`${FRAMEWORK_PACKAGE}/package.json`))
  } catch {
    return undefined
  }
}
const baseDir = resolveBaseDir()
/** The base is usable when it is resolvable AND built (the bootstrap needs its `dist/`). */
const baseAvailable = baseDir !== undefined && existsSync(join(baseDir, 'dist', 'index.js'))

const home = mkdtempSync(join(tmpdir(), 'avf-mount-data-'))
process.env['AVANTF_HOME'] = home

// The prompt texts are user-editable, one `.md` per section under `<home>/prompts` (shared by the
// family's plugins, each owning a prefix). One is
// pre-edited HERE, before the mount, so this smoke proves the EDITED text is what reaches the model
// prompt; the other two must be created with their built-in defaults. Read once, at apply.
const promptDir = join(home, 'prompts')
mkdirSync(promptDir, { recursive: true })
const editedKbEdit = '不要新建一个补充文档。因为这样才能保持一致。'
writeFileSync(join(promptDir, 'mem-kb-edit.md'), `${editedKbEdit}\n`, 'utf8')

// The profile is chosen by the FACT — can the plugin's tree resolve the base? — not by the flag: in
// the workspace the base is always linked, so `AVANTF_ENVINIT_ABSENT=1` alone cannot make it
// unresolvable. The flag is the packed caller's intent and must agree with the fact; the linked and
// unlinked variants of `pack-plugin --mount` are the two real cases.
const envinitAbsent = !baseAvailable
if (process.env['AVANTF_ENVINIT_ABSENT'] === '1' && !envinitAbsent) {
  console.error('mount-smoke: AVANTF_ENVINIT_ABSENT=1 but @avantf/dsh-plugin-base still resolves from the plugin entry')
  console.error('  the workspace link is always present; use `pack-plugin --mount` (unlinked variant) for the base-absent profile')
  process.exit(2)
}

// Offline + deterministic: never let the smoke test download anything (models or artifacts). The
// envinit switch covers the base's provisioning; both switches reach the resolved config through the
// env layer, so `semantic.auto_download` is false too and `mem:model` is declared but settles
// `skipped (policy/download-disabled)` — disk probe only, no network (see `startManagedResources`).
process.env['AVANTF_ENVINIT_AUTO_DOWNLOAD'] = '0'
process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '0'

// The environment hatch the pandoc fallback has to keep honouring (`legacyToolsDir`). Downloads are
// off, so the envinit profile's `mem:pandoc` item settles `skipped` and the plugin points the
// converter at this directory — asserted below by the fallback line naming it. Without this the
// branch could resolve the built-in `~/.avantf/tools` and no assertion would notice.
const toolsOverride = join(home, 'tools-override')
process.env['AVANTF_TOOLS_DIR'] = toolsOverride

const { Context } = require(join(scratch, 'node_modules', '@deepseek-ai', 'cordis'))
const pluginEntry = join(pluginDir, 'lib', 'index.js')
const plugin = await import(pluginEntry)

const ctx = new Context()
// Provide the `tools` service the plugin injects (and records registrations). Faithful enough for
// the tools probe in the startup compatibility gate: `register` returns the exact disposer that
// withdraws THIS tool, and `get` reads the live set back — so the probe's leftover would show up here.
const registeredTools = []
const registeredToolObjects = []
ctx.provide('tools', {
  register: (t) => {
    registeredTools.push(t.name)
    registeredToolObjects.push(t)
    return () => {
      const index = registeredTools.indexOf(t.name)
      if (index >= 0) registeredTools.splice(index, 1)
      const objectIndex = registeredToolObjects.indexOf(t)
      if (objectIndex >= 0) registeredToolObjects.splice(objectIndex, 1)
    }
  },
  get: (name) => registeredToolObjects.find((t) => t.name === name),
})
// The `systemPrompt` registry is injected because the plugin contributes TWO usage sections (when
// to remember/recall, and when to query the document library). A recording stub is enough: what
// this proves is that both land through the real service surface — and that `inject` still lists
// the dependency.
const promptSections = []
// The plugin also contributes ONE CONDITIONAL context (the "相关内容" hint), which needs the
// `context` half of the same service. It is recorded so the assertions below can pin the pairing:
// a hint that registers but never renders is the failure mode worth catching.
const promptContexts = []
ctx.provide('systemPrompt', {
  section: (s) => { promptSections.push(s); return () => {} },
  context: (c) => { promptContexts.push(c); return () => {} },
})
// Provide the `typert` registry: the plugin registers its hand-written host wire face AND, right
// after that, probes the registry for startup compatibility (`src/provision.ts`). The stub must
// therefore answer like the real one — `listPackages`/`list`/`get`/`resolve`/`toJSONSchema` over
// the contributions that were registered — or the healthy mount would report a false WARNING. A
// negative variant (below) proves the probe actually warns when the host answers differently.
const typertContributions = []
/** Schema rows the real registry builds from a contribution: key `<package>#<schema name>`. */
function typertSchemaRows(contributions) {
  return contributions.flatMap((contribution) => contribution.schemas.map((schema) => ({
    ...schema,
    package: contribution.package,
    face: contribution.face,
    key: `${contribution.package}#${schema.name}`,
  })))
}
/**
 * @param contributions - the array `register` appends to (shared with the caller).
 * @param options.probeFailure - true ⇒ `get` answers `undefined` after registration, i.e. the host
 *   accepted the contribution but did not record it. That is the "probe proved the API changed"
 *   mode the negative mount below requires.
 */
function typertStub(contributions, options = {}) {
  const { probeFailure = false } = options
  const rows = () => typertSchemaRows(contributions)
  return {
    // Faithful to the real registry: `register` returns the exact disposer that withdraws THIS
    // contribution. The plugin's one-shot probe relies on it, and so do the counts asserted below.
    register: (contribution) => {
      contributions.push(contribution)
      return () => {
        const index = contributions.indexOf(contribution)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    get: (key) => (probeFailure ? undefined : rows().find((row) => row.key === key)),
    resolve: (key) => {
      const row = rows().find((candidate) => candidate.key === key)
      if (row === undefined) throw new Error(`typert: cannot resolve "${key}"`)
      return row
    },
    listPackages: (filter) => contributions
      .filter((contribution) => filter?.package === undefined || contribution.package === filter.package)
      .map((contribution) => ({
        package: contribution.package,
        face: contribution.face,
        key: `${contribution.package}#${contribution.face}`,
        model: contribution.model,
      })),
    list: (filter) => rows().filter((row) => filter?.package === undefined || row.package === filter.package),
    toJSONSchema: (key) => {
      const row = rows().find((candidate) => candidate.key === key)
      if (row === undefined) throw new Error(`typert: cannot resolve "${key}"`)
      // The real host runs `z.toJSONSchema(row.schema)`; "returned an object" is all the probe reads.
      return { $ref: `#/definitions/${row.name}` }
    },
  }
}
ctx.provide('typert', typertStub(typertContributions))

// ── capture stdout across the mount, for the provisioning guard below ──────────────────────────
// The startup sweep is non-blocking and reports through the logger, so the only place its outcome
// is observable from here is the log itself. Teeing stdout (rather than reaching into the plugin)
// keeps this on the REAL mount path.
const provisionLines = []
// Patch the CONSOLE methods, not `process.stdout.write`: Node's Console captures the stream's
// `write` when it is constructed, so reassigning it intercepts nothing — and the plugin's console
// logger goes through `console.error` anyway.
const realConsole = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    provisionLines.push(args.map((arg) => String(arg)).join(' '))
    realConsole[level](...args)
  }
}
/** Bounded wait for a line, so a slow (but working) sweep cannot hang the smoke. */
async function waitForLine(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (provisionLines.some((line) => match.test(line))) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return provisionLines.some((line) => match.test(line))
}

await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { dataHome: home })

const service = ctx.get('avantfMemory')
const gateway = ctx.get('avantfMem')
const typertFace = typertContributions[0]

// Functional round-trip through the gateway (contract validation + dispatch + envelope).
let functionalOk = false
let ingestedDoc
try {
  const added = await gateway.remember({ content: '冒烟测试：张伟管理李娜' })
  const searched = await gateway.recall({ query: '冒烟测试' })
  const ingested = await gateway.kb({ action: 'ingest', text: '冒烟文档：平台组负责统一网关。', domain: 'notes', source: 'smoke.md', title: 'smoke.md' })
  const queried = await gateway.query({ query: '张伟' })
  ingestedDoc = ingested?.value
  functionalOk =
    added?.ok === true && added?.value?.is_new === true &&
    searched?.ok === true && Array.isArray(searched?.value?.hits) &&
    ingested?.ok === true && ingested?.value?.chunks >= 1 &&
    queried?.ok === true && Array.isArray(queried?.value?.hits)
} catch (error) {
  console.error('functional gateway smoke failed:', error)
}

// ── knowledge maintenance through the SAME gateway ────────────────────────────────────────────
// The path a user takes: edit the managed `.md`, then ask the KB to pull it back in. Run through
// the gateway (not the store) so the wire face, the contract union and the dispatch are all in
// the loop — `sync` is a new action, and a descriptor that never reaches the handler would look
// fine in a unit test of the store alone.
let managedOk = false
let managedLine = ''
try {
  const file = ingestedDoc?.file
  const docId = ingestedDoc?.doc_id
  const underRoot = typeof file === 'string' && file.startsWith(join(home, 'knowledge', 'docs'))
  const onDisk = typeof file === 'string' && existsSync(file)
  const fresh = await gateway.kb({ action: 'sync', dry_run: true })
  if (typeof file === 'string') {
    writeFileSync(file, readFileSync(file, 'utf8').replace('统一网关', '统一网关（已改）'), 'utf8')
  }
  const stale = await gateway.kb({ action: 'sync', dry_run: true })
  const applied = await gateway.kb({ action: 'sync', doc_id: docId })
  const after = await gateway.kb({ action: 'sync', dry_run: true })
  const chunks = gateway.kb({ action: 'detail', doc_id: docId })
  managedOk = underRoot && onDisk
    && fresh?.ok === true && fresh.value.stale.length === 0
    && stale?.ok === true && stale.value.stale.some((f) => f.doc_id === docId)
    && applied?.ok === true && applied.value.reingested === 1
    && after?.ok === true && after.value.stale.length === 0
    && (await chunks)?.value?.chunks?.some((c) => c.text.includes('（已改）')) === true
  managedLine = `managed file: ${managedOk ? 'OK (edit → stale → 重新摄入 → indexed)' : 'FAILED'}`
} catch (error) {
  console.error('knowledge maintenance smoke failed:', error)
  managedLine = 'managed file: FAILED (threw)'
}

// `openDoc` is UI-only, so nothing else exercises it: with an unknown id it must answer with the
// gateway envelope and spawn NOTHING (a real call would launch an editor).
let openDocOk = false
try {
  const missing = await gateway.openDoc({ doc_id: 9_999_999 })
  openDocOk = missing?.ok === false && String(missing?.error ?? '').includes('不存在')
} catch (error) {
  console.error('openDoc smoke failed:', error)
}

// The 知识 tab's single source input and its 选择 picker are UI-only too, and both answer from the
// HOST's filesystem: classification decides which `kb_manage` action the form sends, and the picker
// must never offer a directory ingestion would refuse.
let pickerOk = false
try {
  const url = await gateway.classifySource({ text: 'https://example.com/spec.md' })
  const prose = await gateway.classifySource({ text: '网关设计规范：平台组负责统一网关。' })
  const typo = await gateway.classifySource({ text: '~/definitely-not-here.md' })
  const listing = await gateway.browseDir({})
  const escaped = await gateway.browseDir({ path: '/etc' })
  pickerOk =
    url?.ok === true && url.value.kind === 'url' &&
    prose?.ok === true && prose.value.kind === 'text' &&
    typo?.ok === true && typo.value.kind === 'missing' &&
    listing?.ok === true && typeof listing.value.path === 'string' && Array.isArray(listing.value.entries) &&
    // The picker walks the SAME boundary as ingestion, so an outside path is refused, not listed.
    escaped?.ok === false && /超出允许范围|允许的根|找不到/.test(String(escaped.error))
} catch (error) {
  console.error('source picker smoke failed:', error)
}

// ── the conditional hint, END TO END ─────────────────────────────────────────────────────────
// Registration alone proves nothing here: the chain that can break is a message arriving, the
// SYNC probe answering, and the contribution rendering — in that order, within one step. So this
// drives the real event through the real runtime (the doc and the fact above are already stored)
// and reads the contribution back. The three outcomes that matter: knowledge-only and memory-only
// both render the SAME cross-store line (`kb_query` covers both), and neither renders EMPTY (i.e.
// costs no tokens). A fourth case pins the author filter: a plugin notice is not a user message,
// so the same words arriving as one must NOT move the verdict.
let hintsOk = false
let hintsLine = ''
try {
  const agent = { id: 'smoke-agent' }
  const say = (text, source = { kind: 'user' }) =>
    ctx.emit('agent/inbox/inserted', { agent, message: { source, content: [{ type: 'text', text }] } })
  const rendered = () => promptContexts.map((c) => c.text({ scope: agent }))
  say('完全无关的一句话')
  const forNothing = rendered()
  // A FACT-bearing string arriving as a plugin notice: the probe would fire on these words, so an
  // unchanged empty verdict is what proves the author filter.
  say('张伟管理李娜', { kind: 'plugin:avantf-mission' })
  const forNotice = rendered()
  say('统一网关 平台组')
  const forDoc = rendered()
  say('张伟管理李娜')
  const forFact = rendered()
  hintsOk = promptContexts.length === 1
    && forNothing[0] === ''
    && forNotice[0] === ''
    && forDoc[0].includes('kb_query') && !forDoc[0].includes('mem_recall')
    && forFact[0] === forDoc[0]
  hintsLine = `conditional hint: ${hintsOk ? 'OK (命中知识 / 命中记忆 / 无 / 非用户消息 四类输入渲染正确)' : `FAILED doc=${JSON.stringify(forDoc)} fact=${JSON.stringify(forFact)} none=${JSON.stringify(forNothing)} notice=${JSON.stringify(forNotice)}`}`
} catch (error) {
  hintsLine = `conditional hint: FAILED (${describeError(error)})`
}

// ── the split knowledge tools, through their real registered `execute()` ──────────────────────
// The point of the split is behavioural, so it is checked where the model would hit it: `kb_list`
// must hand back a path that actually exists (that is what makes "edit it yourself" possible), and
// `kb_add` must REFUSE a triple that already exists instead of silently replacing — the failure
// that turned "update the KB" into a second document.
let kbToolsOk = false
let kbToolsLine = ''
try {
  const byName = (name) => registeredToolObjects.find((t) => t.name === name)
  const listed = await byName('kb_list').execute({})
  const rows = Array.isArray(listed?.result) ? listed.result : []
  // This document was ingested with an explicit title, so `kb_add` below collides with it.
  const row = rows.find((r) => r.title === 'smoke.md')
  const listedPath = typeof row?.file === 'string' && existsSync(row.file)
  const listedSqlite = byName('kb_list') !== undefined

  const refused = await byName('kb_add').execute({ domain: 'notes', source: 'smoke.md', title: 'smoke.md', text: '重复入库' })
  const addedNew = await byName('kb_add').execute({ domain: 'notes', source: 'smoke.md', title: '另存一篇', text: '新的一篇' })

  // `kb_add` on a source_uri is ADD-ONLY too: the first call ingests the file, the second must be
  // refused with the existing doc_id and the managed path — never a silent replace. The scratch dir
  // is created under the process cwd, which IS the ingestion boundary's default root.
  const conflictDir = mkdtempSync(join(process.cwd(), '.avf-kbadd-'))
  let uriAddOk = false
  let uriRefuseOk = false
  try {
    const sourceFile = join(conflictDir, 'uri-smoke.md')
    writeFileSync(sourceFile, '本地文件冒烟：网关由平台组维护。')
    const added = await byName('kb_add').execute({ domain: 'notes', source: 'uri', source_uri: sourceFile })
    uriAddOk = added?.ok === true && typeof added?.result?.doc_id === 'number'
    const collided = await byName('kb_add').execute({ domain: 'notes', source: 'uri', source_uri: sourceFile })
    const collidedText = String(collided?.error ?? '')
    uriRefuseOk = added?.ok === true && collided?.ok === false
      && collidedText.includes(`doc_id=${String(added.result.doc_id)}`)
      && collidedText.includes(String(added.result.file))
  } finally {
    rmSync(conflictDir, { recursive: true, force: true })
  }

  // A URL identity collides BEFORE any fetch: seed the URL as a title, then `kb_add` it. A fetch
  // attempt would be refused as loopback, so "只新增" (and no boundary refusal) is the proof that
  // the plan stage resolved and looked the identity up without touching the network.
  const urlUri = 'http://127.0.0.1:1/x'
  const seededUrl = await gateway.kb({ action: 'ingest', text: 'URL 冒烟。', domain: 'notes', source: 'url', title: urlUri })
  const urlCollided = await byName('kb_add').execute({ domain: 'notes', source: 'url', source_uri: urlUri })
  const urlText = String(urlCollided?.error ?? '')
  const urlRefuseOk = seededUrl?.ok === true && urlCollided?.ok === false
    && urlText.includes('只新增') && !urlText.includes('拒绝抓取')

  // REAL behaviour of the paste gate: two calls with NO title and NO source (both default to
  // `default`) must become TWO documents. The title is derived from the body, so the second paste
  // no longer lands on the first one's identity and silently overwrites it — the data-loss defect.
  const pasteA = await gateway.kb({ action: 'ingest', text: '粘贴甲：第一行即标题。', domain: 'notes' })
  const pasteB = await gateway.kb({ action: 'ingest', text: '粘贴乙：另一个标题。', domain: 'notes' })
  const pastedIds = [pasteA?.value?.doc_id, pasteB?.value?.doc_id]
  const pastedRows = (await byName('kb_list').execute({ domain: 'notes' }))?.result ?? []
  const twoPastes = pasteA?.ok === true && pasteB?.ok === true
    && typeof pastedIds[0] === 'number' && typeof pastedIds[1] === 'number' && pastedIds[0] !== pastedIds[1]
    && pastedIds.every((id) => pastedRows.some((r) => r.doc_id === id))

  // The refusal now comes from the STORE (`ingestNew` throws), so the tool boundary returns its
  // `{ok:false,error}` envelope — not the old successful `{result:{error}}` the local pre-check
  // produced. The message must still be actionable: it names the existing document (`doc_id`) and
  // the managed `.md` to edit / the new title to choose.
  const refusedText = String(refused?.error ?? refused?.result?.error ?? '')
  kbToolsOk = listedSqlite && listedPath
    && refused?.ok === false && refusedText.includes('已存在') && refusedText.includes('doc_id=')
    && addedNew?.ok === true && addedNew?.result?.doc_id !== undefined
    && uriAddOk && uriRefuseOk && urlRefuseOk
    && twoPastes
  kbToolsLine = `kb tools: ${kbToolsOk ? 'OK (kb_list 带出存在的路径 · kb_add 拒绝同名 · kb_add 可新增 · kb_add source_uri 只新增 · URL 冲突不抓取 · 两次无标题粘贴得到两篇)' : `FAILED listed=${String(listedPath)} refused=${JSON.stringify(refused)} added=${JSON.stringify(addedNew)} uri=${String(uriAddOk)}/${String(uriRefuseOk)} url=${String(urlRefuseOk)} pastes=${JSON.stringify([pasteA, pasteB])}`}`
} catch (error) {
  kbToolsLine = `kb tools: FAILED (${describeError(error)})`
}

// ── 知识域写入侧清单 + 缺省 source，走真实的 gateway（契约解析 + dispatch + store 校验） ─────────
// Two behaviours that are only visible on the real path: an omitted `source` must resolve to
// `default` and show up in the document identity / `source_ref`, and a `domain` outside the
// configured allowlist must be REFUSED with the allowed values named (the picker in the UI is not
// the guard — agent / CLI / MCP writes hit the same store check).
let domainOk = false
let domainLine = ''
try {
  const noSource = await gateway.kb({ action: 'ingest', text: '冒烟文档：缺省来源的正文。', domain: 'notes', title: '缺省来源' })
  const hits = await gateway.query({ query: '缺省来源的正文' })
  const refs = (hits?.value?.hits ?? []).map((hit) => String(hit.source_ref ?? ''))
  const ref = refs.find((r) => r.startsWith('notes:default:')) ?? ''
  const refusedDomain = await gateway.kb({ action: 'ingest', text: '不该入库', domain: 'smoke', source: 'x' })
  const reason = String(refusedDomain?.error ?? '')
  domainOk = noSource?.ok === true
    && hits?.ok === true && ref !== ''
    && refusedDomain?.ok === false && reason.includes('知识域') && reason.includes('notes') && reason.includes('design')
  domainLine = `domain allowlist : ${domainOk ? 'OK (缺省 source 落为 default；清单外 domain 被拒并列出允许值)' : `FAILED ingest=${JSON.stringify(noSource)} refs=${JSON.stringify(refs)} refused=${JSON.stringify(refusedDomain)}`}`
} catch (error) {
  domainLine = `domain allowlist : FAILED (${String(error)})`
}

// ── 知识域「+」：走真实的 UI 专用 gateway 方法，写回 store 配置并且不重启就可用 ────────────────
// The picker's 「+」 is a USER action with no agent tool behind it, so the whole path — descriptor,
// `@Remote` handler, store config write, live allowlist — is only exercised here.
let addDomainOk = false
let addDomainLine = ''
try {
  const added = await gateway.kbAddDomain({ domain: 'smoke-added' })
  const intoNew = await gateway.kb({ action: 'ingest', text: '新增领域的正文。', domain: 'smoke-added', source: 'x' })
  const catalog = await gateway.kbDomains({})
  const configText = readFileSync(join(home, 'configs', 'knowledge.yaml'), 'utf8')
  addDomainOk = added?.ok === true
    && Array.isArray(added.value?.domains) && added.value.domains.includes('smoke-added')
    && intoNew?.ok === true
    && catalog?.ok === true && catalog.value.domains.includes('smoke-added')
    && configText.includes('smoke-added')
  addDomainLine = `domain add (+)    : ${addDomainOk ? 'OK (新增领域写入配置并立即可用)' : `FAILED added=${JSON.stringify(added)} ingest=${JSON.stringify(intoNew)}`}`
} catch (error) {
  addDomainLine = `domain add (+)    : FAILED (${String(error)})`
}

// ── degraded mount: a store that cannot open must not stop the host booting ────────────────────
// `buildRuntime` throws for a corrupt or locked database, an unwritable data home, or a database
// written by a NEWER build (migrations are one-way), and a throwing `apply` is a failed loader row
// — which is enough to fail the whole `dsh web` boot. So the plugin degrades instead: the five tools
// stay registered and answer with the reason.
//
// The scenario is "the RESOLVED data root cannot be opened", so both layers are pointed at the
// unusable path for the duration: the profile value is layer ②, and `$AVANTF_HOME` (④, set to this
// run's temp home at the top) outranks it — leaving the env alone would make the plugin resolve a
// perfectly good root and mount healthily, which tests nothing.
const blockedHome = join(home, 'not-a-directory')
writeFileSync(blockedHome, 'x') // a FILE where the runtime needs to create its store directories
const healthyHome = process.env['AVANTF_HOME']
process.env['AVANTF_HOME'] = blockedHome
const degradedCtx = new Context()
const degradedTools = []
degradedCtx.provide('tools', { register: (t) => { degradedTools.push(t); return () => {} } })
degradedCtx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
degradedCtx.provide('typert', { register: () => async () => {} })
let degradedMounted = true
try {
  await degradedCtx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { dataHome: blockedHome })
} catch (error) {
  degradedMounted = false
  console.error('degraded mount threw (it must not):', error)
} finally {
  if (healthyHome === undefined) delete process.env['AVANTF_HOME']
  else process.env['AVANTF_HOME'] = healthyHome
}
// DSH validates the declared parameters BEFORE `execute`, even here, so the call has to be a legal
// one for the tool it targets — which is itself part of what this checks.
const degradedAdmin = degradedTools.find((t) => t.name === 'mem_admin')
const degradedEnvelope = degradedAdmin === undefined ? undefined : await degradedAdmin.execute({ action: 'list' })
const degradedOk =
  degradedMounted &&
  degradedTools.length === 8 &&
  degradedCtx.get('avantfMemory') === undefined &&
  degradedEnvelope?.ok === false &&
  String(degradedEnvelope?.error ?? '').includes('memory unavailable')

// ── startup dsh compatibility gate, POSITIVE: the healthy mount ran it off the base ─────────────
// Asserted here rather than inferred, because without it "the probe passed" and "the probe never
// ran" are indistinguishable in the log.
//
// NORMAL profile: the base is resolvable, so the gate it carries must have run and printed its ok
// line. `kitFromBaseOk` is the end-to-end proof that the shared KIT was consumed from the base at
// runtime: the base's `PromptFiles` writer logs `prompt file was blank and has been filled:` while it
// creates the two default prompt files. The plugin's own bundle must NOT contain that code
// (`bundleHasNoKit` here, and the artifact gates), so "the prompt files worked" cannot be explained
// by an inlined copy.
//
// BASE-ABSENT profile (`AVANTF_ENVINIT_ABSENT=1`): nothing can resolve the base, so the plugin warns
// and takes the legacy sweep, which the provisioning guard below asserts instead. That is also the
// end-to-end proof that the bundled bootstrap code ran (a static import would have thrown during
// module evaluation instead).
const compatOk = provisionLines.some((line) => line.includes('compat:') && line.includes('ok'))
// The base's `PromptFiles` writer logs one of these while it materializes the two untouched files.
const kitFromBaseOk = provisionLines.some((line) => /prompt file (?:created|was blank and has been filled):/.test(line))
const frameworkMissingOk = provisionLines.some((line) =>
  line.includes('@avantf/dsh-plugin-base could not be made available'))
// Provenance: the kit lives in the base's dist, never in the plugin bundle.
const KIT_MARKER = 'prompt file was blank and has been filled'
const bundleHasNoKit = !readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8').includes(KIT_MARKER)
const baseHasKit = baseDir !== undefined
  && existsSync(join(baseDir, 'dist', 'kit', 'prompt_files.js'))
  && readFileSync(join(baseDir, 'dist', 'kit', 'prompt_files.js'), 'utf8').includes(KIT_MARKER)

// ── startup dsh compatibility gate, NEGATIVE: the plugin must NOT mount on a changed host ───────
// The stub accepts the probe contribution but answers `get` with undefined after registration — the
// shape of "the host no longer records what we gave it". The plugin must log a `compat:` WARNING,
// leave ONE `/mem` command that explains why, and return with an EMPTY mount: no runtime/service, no
// tools, no remote, no real typert face, and no throw. Without this, the gate would be untested (the
// healthy path cannot tell it apart from a probe that never runs).
//
// The negative mount needs the base loaded, so it runs only in the profile where the base resolves.
let negativeThrew = false
let negativeInvocations = -1
let negativeCommand
let negativeCommandText = ''
let compatNegativeOk = true
if (baseAvailable) {
  const negativeCtx = new Context()
  const negativeTools = []
  const negativeCommands = []
  negativeCtx.provide('tools', { register: (t) => { negativeTools.push(t); return () => {} } })
  negativeCtx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
  negativeCtx.provide('commands', { register: (d) => { negativeCommands.push(d); return () => {} } })
  const negativeContributions = []
  negativeCtx.provide('typert', typertStub(negativeContributions, { probeFailure: true }))
  try {
    await negativeCtx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { dataHome: join(home, 'compat-negative') })
  } catch (error) {
    negativeThrew = true
    console.error('negative compatibility mount threw (it must not):', error)
  }
  negativeInvocations = negativeContributions.flatMap((contribution) => contribution.invocations ?? []).length
  // The megaphone is the operator's only in-product route to the reason.
  negativeCommand = negativeCommands[0]
  negativeCommandText = negativeCommand === undefined ? '' : String((await negativeCommand.handler()).text ?? '')
  compatNegativeOk =
    !negativeThrew &&
    // The gate logged the proven reason ...
    provisionLines.some((line) => line.includes('compat:') && (line.includes('INCOMPATIBLE') || line.includes('REFUSING')))
    // ... left one command that prints it ...
    && negativeCommands.length === 1
    && negativeCommand.name === 'mem'
    && negativeCommandText.includes('兼容性检查未通过')
    && negativeCommandText.includes('schemas are missing after registration')
    // ... and nothing at all was registered by the plugin.
    && negativeTools.length === 0
    && negativeCtx.get('avantfMemory') === undefined
    && negativeCtx.get('avantfMem') === undefined
    && negativeInvocations === 0
    && negativeContributions.length === 0
}
const frameworkLine = envinitAbsent
  ? `framework       : ${frameworkMissingOk ? 'OK (unresolvable → WARNING, legacy provisioning path)' : 'FAILED (no @avantf/dsh-plugin-base-could-not-be-made-available warning)'}`
  : 'framework       : OK (@avantf/dsh-plugin-base loaded through the inlined bootstrap)'
const compatLine = envinitAbsent
  ? 'compat          : SKIPPED (base unavailable — the legacy path has no gate)'
  : `compat          : ${compatOk && kitFromBaseOk && bundleHasNoKit && baseHasKit ? 'OK (gate ran off the base; prompt-kit served from the base at runtime)' : `FAILED ok=${String(compatOk)} kit-from-base=${String(kitFromBaseOk)} bundle-clean=${String(bundleHasNoKit)} base-has-kit=${String(baseHasKit)}`}`
const compatNegativeLine = baseAvailable
  ? `compat (neg)    : ${compatNegativeOk ? 'OK (changed host → REFUSING, one /mem command, empty mount, no throw)' : `FAILED threw=${String(negativeThrew)} commands=${String(negativeCommand === undefined ? 0 : 1)} text=${JSON.stringify(negativeCommandText.slice(0, 120))} invocations=${String(negativeInvocations)}`}`
  : 'compat (neg)    : SKIPPED (base unavailable; no gate to run)'

// ── provisioning guard: a harness PLUMBING failure must never be the model's reason ───────────
// The mount smoke cannot assert "the model is ready" (a CI box may have no cache and no network),
// which is exactly how `installContext` failing to forward `artifactEnv` hid here: the model's
// failure was EXPECTED, so nobody looked at WHY. What is always assertable is that the reason is
// never the plugin's own plumbing — "需要 artifactEnv.runtime" and friends mean the sweep is passing
// the wrong context, not that the machine lacks a model.
//
// The path decides what "provisioning" means:
//   - envinit path  → the plugin declared its expensive resources to the base and continued. The
//     evidence is each item's terminal state (`envinit: mem:pandoc …` — `skipped` here, because
//     downloads are off), the FALLBACK that follows it (the converter is pointed
//     at `AVANTF_TOOLS_DIR`, the environment hatch `legacyToolsDir` must not lose) plus the LOCAL
//     warm that runs from `mem:model`'s settle callback (`model bootstrap: warm start`).
//   - legacy path   → the engine's own `provision:` sweep, asserted the way it always was.
const envinitPath = !envinitAbsent
const pandocSettled = await waitForLine(/envinit: mem:pandoc (?:is )?(?:skipped|present|installed)\b/, 20000)
// Only the envinit path prints a fallback line, so only it waits for one (the legacy profile has no
// `envinit:` lines at all, and waiting 20 s for one would just slow the run down).
let pandocFallbackOk = true
if (envinitPath) {
  // The message names the resolved directory, which is now the family root / the operator's hatch —
  // there is no legacy directory to fall back TO any more.
  await waitForLine(/envinit: pandoc unavailable from the framework; the converter will use .*/, 20000)
  pandocFallbackOk = provisionLines.some((line) => line.includes('pandoc unavailable from the framework') && line.includes(toolsOverride))
}
const warmStarted = await waitForLine(/model bootstrap: warm start\b/, 20000)
const provisionSwept = envinitPath ? true : await waitForLine(/provision: (全部就绪|\d+\/\d+ 未就绪)/, 30000)
const modelLines = provisionLines.filter((line) => line.includes('provision[model]'))
const plumbing = /需要 artifactEnv|artifactEnv\.runtime|Cannot read properties of undefined/
const relevantLines = envinitPath
  ? provisionLines.filter((line) => line.includes('model bootstrap:') || line.includes('envinit:'))
  : modelLines
const pluginMounted = service !== undefined && gateway !== undefined
const provisionOk = envinitPath
  ? pluginMounted && pandocSettled && pandocFallbackOk && warmStarted && !relevantLines.some((line) => plumbing.test(line))
  : pluginMounted && provisionSwept && !relevantLines.some((line) => plumbing.test(line))
const provisionLine = envinitPath
  ? `provisioning    : ${provisionOk ? 'OK (envinit: mem:pandoc 已到终态并回退到 AVANTF_TOOLS_DIR；本地预热已启动)' : `FAILED mounted=${String(pluginMounted)} pandoc=${String(pandocSettled)} fallback=${String(pandocFallbackOk)} warm=${String(warmStarted)}`}`
  : `provisioning    : ${provisionOk ? `OK (sweep 已收尾；model 的原因不是管道错误：${modelLines.filter((l) => l.includes('失败')).length === 0 ? '本次无失败' : '本次失败但原因合法'})` : `FAILED swept=${String(provisionSwept)} lines=${JSON.stringify(modelLines.slice(-2))}`}`
Object.assign(console, realConsole)

// The editable prompt files, per profile. With the base (and its kit) available the loader writes
// the two missing files with their defaults, reads the pre-edited one verbatim, and the registered
// text equals the files on disk. With the base absent the mount DEGRADES: the plugin injects its OWN
// default bodies, writes NOTHING, and leaves the user's pre-edited file untouched — the "base 缺失
// 仍能挂载" contract for the prompt layer. A file the plugin created but did not inject — or
// injected but did not create — is the failure this pins. The edited text also carries an explanatory
// "因为", so on the base-present path the soft check on EDITED text has to have produced its warning:
// the defaults are guarded hard in unit tests, and edited text is warned about, never modified.
const promptFileNames = ['mem-memory-usage.md', 'mem-knowledge-usage.md', 'mem-kb-edit.md']
const promptFilesOk = envinitAbsent
  ? promptSections.length === 3 &&
    promptSections[2]?.text !== editedKbEdit &&
    promptSections.every((section) => section.text.length > 0) &&
    // Nothing was written: the two files the loader would have created are absent …
    !existsSync(join(promptDir, 'mem-memory-usage.md')) &&
    !existsSync(join(promptDir, 'mem-knowledge-usage.md')) &&
    // … and the user's pre-edited file is untouched.
    readFileSync(join(promptDir, 'mem-kb-edit.md'), 'utf8') === `${editedKbEdit}\n` &&
    !provisionLines.some((line) => line.includes('prompt file created'))
  : promptSections.length === 3 &&
    promptFileNames.every((file) => existsSync(join(promptDir, file))) &&
    promptSections[2]?.text === editedKbEdit &&
    readFileSync(join(promptDir, 'mem-kb-edit.md'), 'utf8') === `${editedKbEdit}\n` &&
    provisionLines.some((line) => line.includes('prompt text:') && line.includes('explains why')) &&
    promptSections.every((section, index) => readFileSync(join(promptDir, promptFileNames[index]), 'utf8').trim() === section.text)

const ok =
  !!service &&
  typeof service.query === 'function' &&
  !!gateway &&
  // Five tool-backed methods plus the UI-only ones (`openDoc`, `classifySource`, `browseDir`,
  // `kbDomains`, `kbAddDomain`).
  ['remember', 'recall', 'admin', 'kb', 'query', 'openDoc', 'classifySource', 'browseDir', 'kbDomains', 'kbAddDomain']
    .every((m) => typeof gateway[m] === 'function') &&
  functionalOk &&
  managedOk &&
  openDocOk &&
  pickerOk &&
  hintsOk &&
  kbToolsOk &&
  domainOk &&
  addDomainOk &&
  provisionOk &&
  typertFace?.face === 'host' &&
  typertFace?.invocations.length === 10 &&
  typertFace?.invocations.every((d) => d.namespace === 'avantfMem' && d.service === 'avantfMem') &&
  ['mem_remember', 'mem_recall', 'mem_admin', 'kb_add', 'kb_list', 'kb_remove', 'kb_reindex', 'kb_query'].every((t) => registeredTools.includes(t)) &&
  // `kb_manage` and `sync` are deliberately NOT model-facing any more (the UI keeps them).
  !registeredTools.includes('kb_manage') &&
  plugin.inject.includes('systemPrompt') &&
  promptSections.length === 3 &&
  promptSections[0]?.name === 'avantf:memory-usage' &&
  promptSections[1]?.name === 'avantf:knowledge-usage' &&
  promptSections[2]?.name === 'avantf:kb-edit' &&
  promptSections.every((s) => typeof s.text === 'string') &&
  promptSections[0].text.includes('mem_remember') &&
  // `mem_recall` guidance was removed from the standing section: the per-message hint is the read
  // nudge, and it names the CROSS-STORE `kb_query` (whose result already carries memory facts).
  // The memory-only actions (chain/probe/reason/contradict) live in `mem_recall`'s own description.
  !promptSections[0].text.includes('mem_recall') &&
  promptSections[1].text.includes('kb_query') &&
  promptSections[1].text.includes('用户提供的成篇资料') &&
  promptSections[2].text.includes('不要新建一个补充文档') &&
  promptFilesOk &&
  promptContexts.length === 1 &&
  promptContexts[0]?.name === 'avantf:mem-hint' &&
  // With no state for the assembling scope it renders EMPTY — the token-free "nothing found".
  promptContexts.every((c) => typeof c.text === 'function' && c.text({}) === '') &&
  degradedOk &&
  // The startup gate and the base itself, per profile: the base passed the gate AND served the
  // prompt kit at runtime (normal), and the unresolvable base is a WARNING plus the legacy sweep
  // (base-absent). The negative half ran only where a gate existed.
  (envinitAbsent ? frameworkMissingOk : compatOk && kitFromBaseOk && bundleHasNoKit && baseHasKit) &&
  compatNegativeOk

console.log('plugin entry     :', pluginEntry)
console.log('plugin name      :', plugin.name)
console.log('avantfMemory     :', !!service)
console.log('avantfMem remote :', !!gateway)
console.log('typert face      :', typertFace ? `${typertFace.face} (${typertFace.invocations.length} invocations)` : 'MISSING')
console.log('tools registered :', JSON.stringify(registeredTools))
console.log('prompt sections  :', promptSections.length === 0 ? 'MISSING' : promptSections.map((s) => `${s.name}@${s.order} (${s.text.length} chars)`).join(', '))
console.log('prompt files     :', promptFilesOk
  ? envinitAbsent
    ? `OK (base absent → plugin defaults injected, nothing written, edited file untouched, in ${promptDir})`
    : `OK (1 edited file injected verbatim, 2 created with defaults, in ${promptDir})`
  : `FAILED (${promptDir})`)
console.log('prompt contexts  :', promptContexts.length === 0 ? 'MISSING' : promptContexts.map((c) => `${c.name}@${c.order} (conditional)`).join(', '))
console.log(managedLine)
console.log('openDoc (UI-only):', openDocOk ? 'OK (unknown doc answered with the envelope, nothing launched)' : 'FAILED')
console.log('source input     :', pickerOk ? 'OK (URL/prose/typo classified; browseDir lists, refuses /etc)' : 'FAILED')
console.log(hintsLine)
console.log(kbToolsLine)
console.log(domainLine)
console.log(addDomainLine)
console.log(provisionLine)
console.log(frameworkLine)
console.log(compatLine)
console.log(compatNegativeLine)
console.log('degraded mount   :', degradedMounted ? `mounted, ${String(degradedTools.length)} tools, avantfMemory=${String(degradedCtx.get('avantfMemory') !== undefined)}, envelope=${JSON.stringify(degradedEnvelope)}` : 'THREW')
service?.shutdown?.()
// A prepared scratch belongs to the caller (pack-plugin owns the tarball extract).
if (ownsScratch) rmSync(scratch, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })

if (!ok) { console.error('\nMOUNT SMOKE FAILED'); process.exitCode = 1 }
else console.log('\nMOUNT SMOKE OK — @avantf/dsh-mem mounts as a standard DSH Cordis plugin.')
