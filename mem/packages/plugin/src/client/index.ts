/**
 * @avantf/dsh-mem — DSH client half.
 *
 * Registers two `conversation.view` tabs (记忆 id=memory, 知识 id=knowledge) that sit
 * next to 对话/轨迹 in the session view strip and talk to the host through the
 * Typert Remote bridge `avantfMem`.
 *
 * Design choices worth keeping:
 *
 * 1. The plugin injects only `slots` + `remote`, never `remote.avantfMem`. Boot
 *    audits every client entry and THROWS when one is still pending, so depending
 *    on a namespace an out-of-tree package can only mount at runtime would take
 *    the whole web tree down. The namespace is mounted in `apply` and read back
 *    through `ctx.get()` — a dotted `ctx.remote.avantfMem` read is refused unless
 *    that exact key is in this plugin's own `inject`, which cannot be satisfied.
 * 2. Every remote call is normalized and surfaced: the raw response is logged
 *    (prefixed `[avantf-mem]`) and rendered as an explicit status/error line, so
 *    an empty result is never indistinguishable from a failed call.
 * 3. Full DESIGN §12 surface: tab A does CRUD (edit/archive/restore/feedback) +
 *    fact detail (entities/triples) + open contradictions; tab B does filtered
 *    cross-store query (kind/domain/source) with results grouped by
 *    `记忆 / domain → source`, plus KB management (ingest/import/list/detail/
 *    remove/reindex). Generation stays external (Plan A) — no answer synthesis.
 *
 * Built as a DSH client bundle (`tsdown.config.ts` → `clientBundle`): a CJS
 * factory self-registering through `window.__ModuleLoader__.load`, with `react`
 * resolved from the platform module table.
 */
import * as React from 'react'
import css from './pages.module.css'
import { clientContribution } from '../remote.js'
// Subpath import on purpose: the client bundle must not pull in the whole
// contract (tool unions + JSON-Schema derivation); this module has no deps.
import { unwrapRemoteEnvelope, formatViolations, type RemoteEnvelope } from '@avantf/mem-contract/remote'
// Payload shapes come from the contract instead of being mirrored here (AGENTS.md makes it the
// single source for UI payloads). `import type` is erased, so the client bundle still pulls only
// the `/remote` subpath it needs — a local mirror is what let a server-side field go missing.
import type {
  BrowseListing,
  ContradictionRecord,
  DocumentDetail,
  DocumentSummary,
  DomainCatalog,
  FactDetail,
  FactPage,
  FactSummary,
  KbDocFile,
  KbSyncReport,
  OpenOutcome,
  OpenTarget,
  RecallHit,
  RecallResult,
  SourceClassification,
  RetrievalHealthSummary,
  StatsSummary,
} from '@avantf/mem-contract'
import { summarize } from './summarize.js'
import { mergeDocs, mergePage } from './paging.js'
import { checkNewDomain, domainOptions, domainPickerMode } from './domains.js'
import { conflictMessage, ingestConflict } from './ingest.js'
import { hostSkew, hostSupports, staleHostText, transportHint } from './wire.js'

const h = React.createElement

/** The `avantfMem` Remote namespace the host gateway exposes (mirrors the five tools). */
interface AvantfRemote {
  remember(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  recall(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  admin(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  kb(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  query(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  /** UI-only: open one managed document file (or its directory) in the user's editor. */
  openDoc(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  /** UI-only: what IS this string — URL, local file, local directory, missing, or pasted text. */
  classifySource(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  /** UI-only: one directory listing for the 选择 picker (same boundary as ingestion). */
  browseDir(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  /** UI-only: the domain picker's options (allowlist ∪ library) and whether the allowlist is active. */
  kbDomains(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
  /** UI-only: append one domain to the store config's allowlist and select it (the write form's 「+」). */
  kbAddDomain(args: Record<string, unknown>): Promise<RemoteEnvelope<unknown>>
}

/**
 * The host's answer for one source string, NORMALIZED at the boundary that receives it.
 *
 * The shape comes from the contract (no hand-mirror to drift), and the three list fields are read
 * through {@link normalizeClassification} rather than assumed: this object is dereferenced inside a
 * render body (`info.paths.length`, `info.missing.join`), and a field the host stopped sending would
 * throw there — which the shell renders as an empty panel with no retry for the session.
 */
function normalizeClassification(value: SourceClassification | null | undefined): SourceClassification | null {
  if (value === null || value === undefined) return null
  const list = (candidate: readonly string[] | undefined): string[] =>
    Array.isArray(candidate) ? candidate.filter((entry): entry is string => typeof entry === 'string') : []
  return {
    kind: value.kind,
    paths: list(value.paths),
    missing: list(value.missing),
    reasons: list(value.reasons),
    files: typeof value.files === 'number' ? value.files : 0,
  }
}

/** The slice of the client Context this plugin uses. */
interface ClientContext {
  slots: {
    inject(name: string, register: () => void): void
    register(
      options: { name: string; id: string; order: number; label: () => string },
      component: () => unknown,
    ): void
  }
  remote: {
    /** Mount this package's own Remote contribution (see `./remote.ts`). */
    $mount(contribution: unknown): Promise<() => Promise<void>>
  }
  /**
   * Cordis service lookup. Required here because `ctx.remote.avantfMem` is
   * guarded: a dotted property read demands that exact key in the plugin's own
   * `inject`, which would park this entry before it can mount the namespace.
   * `get()` has no such requirement and returns the mounted service object.
   */
  get(name: string): unknown
}

/** Either the decoded value or the exact failure text; never a silent miss. */
type RemoteOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

const NOT_MOUNTED
  = 'avantfMem Remote 未挂载：本插件自带的 typert contribution 挂载失败（详见控制台错误），暂时无法读取数据。'

/** One 记忆 tab; the host `admin` list default is the same. */
const MEMORY_PAGE_SIZE = 50

/** How close (px) the list's end must come to the scrollport before the next page loads. */
const AUTO_LOAD_MARGIN_PX = 300

/** One page of the 知识 tab's document list; the 记忆 tab pages at 50 for the same reason. */
const DOC_PAGE_SIZE = 50

/**
 * The wire revision the host last reported, and whether its absence/mismatch was logged.
 *
 * Module state, not React state, on purpose: EVERY call goes through {@link callRemote}, so the
 * first answer teaches the client which host process it is talking to, whichever panel asked. The
 * host is loaded once, so this cannot change under a session — one write is the whole story.
 */
let hostWire: number | undefined
let skewLogged = false

/**
 * Run one Remote call and normalize every shape it can take: the transport's
 * `{ok,value}` envelope wrapping the gateway's own `{ok,value}` /
 * `{ok,error,violations}` envelope, a bare value, or a thrown carrier failure.
 * Both layers are peeled (see `unwrapRemoteEnvelope`), so `value` is always the
 * payload and `error` is always the host's message. Failures are returned, never
 * swallowed.
 *
 * `requires` is the wire revision that FIRST carried this method, and is how the version marker
 * becomes a gate: a host whose REPORTED revision predates the method is never asked (the call is not
 * sent), and the failure names the remedy instead of surfacing the gateway's 404. No current method
 * needs it — all ten predate the marker — but a method added later MUST pass its revision here; see
 * `src/remote.ts` `WIRE_VERSION`'s bump rule.
 *
 * An UNKNOWN revision (no answer observed yet: this is the first call) does not block — refusing
 * there would deadlock a gated method that happens to be first, and would refuse every host during
 * an upgrade. It is sent, and a host that really is too old answers with the 404 that
 * {@link transportHint} explains.
 */
async function callRemote<T>(
  label: string,
  pending: Promise<unknown>,
  requires?: number,
): Promise<RemoteOutcome<T>> {
  if (requires !== undefined && hostWire !== undefined && !hostSupports(hostWire, requires)) {
    return { ok: false, error: staleHostText(hostWire, requires, label) }
  }
  try {
    const result = await pending
    console.log(`[avantf-mem] ${label} ->`, result)
    const decoded = unwrapRemoteEnvelope<T>(result)
    if (typeof decoded.wire === 'number') hostWire = decoded.wire
    // A version skew is a NOTE, never a failure: an unrecognized revision usually still carries the
    // fields the panels render. Logged once per session (the host cannot change under it). Only a
    // SUCCESSFUL read (or one that did report a revision) can say anything about the two halves — a
    // transport failure carries no envelope, and its own message is the useful one.
    const skew = decoded.ok || decoded.wire !== undefined ? hostSkew(decoded.wire) : undefined
    if (skew !== undefined && !skewLogged) {
      skewLogged = true
      console.warn(`[avantf-mem] ${skew}`)
    }
    if (decoded.ok) return { ok: true, value: decoded.value }
    const violations = formatViolations(decoded.violations)
    return { ok: false, error: violations ? `${decoded.error}（${violations}）` : decoded.error }
  } catch (error) {
    console.error(`[avantf-mem] ${label} failed`, error)
    // A rejected carrier call is where a host too old to know the method shows up; say that rather
    // than forwarding a bare "404" that reads like a missing record.
    return { ok: false, error: transportHint(error) }
  }
}

/**
 * Response-ordering guard shared by every click-driven fetch (detail, doc detail,
 * docs list, contradictions — each used to hand-roll the same ++seq/compare dance):
 * a slow reply must never overwrite a newer one.
 */
function useSeqGuard(): { begin: () => number; isCurrent: (seq: number) => boolean } {
  const ref = React.useRef(0)
  return React.useMemo(() => ({
    begin: () => ++ref.current,
    isCurrent: (seq: number) => seq === ref.current,
  }), [])
}

/** The element that actually scrolls this panel, walking up to it (the conversation's scroll body). */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current !== null) {
    const overflowY = getComputedStyle(current).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
      return current
    }
    current = current.parentElement
  }
  return null
}

/**
 * Call `onLoadMore` when the user scrolls near the end of the panel.
 *
 * A scroll listener, not an `IntersectionObserver`, for the three reasons this seat makes an
 * observer the wrong tool:
 *
 * 1. **`rootMargin` cannot prefetch here.** The panel does not own a scrollport — the conversation's
 *    `.scrollBody` does, and an ancestor's clip rect is NOT expanded by `rootMargin` (only the
 *    intersection root's is). The promised look-ahead simply never happened.
 * 2. **An observer only reports threshold CHANGES.** One page that failed to load left the sentinel
 *    visible, so no new callback arrived and auto-load stayed dead until something else moved it.
 *    A scroll listener is level-triggered: the next scroll event tries again.
 * 3. **The scrollport is found, not assumed.** `scrollParentOf` walks up to whatever element really
 *    scrolls, so this keeps working if the panel ever gets its own scroller.
 *
 * `version` re-checks after a page lands: a page that does not fill the scrollport produces no
 * scroll event, and without the re-check loading would stop after the first page.
 */
function useLoadMoreOnScroll(
  rootRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onLoadMore: () => void,
  version: number,
): void {
  const latest = React.useRef(onLoadMore)
  latest.current = onLoadMore
  const enabledRef = React.useRef(enabled)
  enabledRef.current = enabled
  const checkRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const scroller = scrollParentOf(root)
    const target: HTMLElement | Window = scroller ?? window
    let queued = false
    const check = (): void => {
      queued = false
      if (!enabledRef.current || scroller === null) return
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - AUTO_LOAD_MARGIN_PX) {
        latest.current()
      }
    }
    checkRef.current = check
    const onScroll = (): void => {
      if (queued) return
      queued = true
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check)
      else check()
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    check() // the first page may leave the scrollport unfilled
    return () => {
      checkRef.current = () => {}
      target.removeEventListener('scroll', onScroll)
    }
  }, [rootRef])

  React.useEffect(() => { checkRef.current() }, [version, enabled])
}

interface ActionHooks {
  setLoading(loading: boolean): void
  setNotice(notice: string | undefined): void
  setError(error: string | undefined): void
}

/**
 * The one mutation flow both panels share: run a Remote call, optionally refresh
 * FIRST (so the mutation's own notice/error survives a list reload that clears
 * the error line), then surface `完成`/`失败` with an optional value summary.
 */
async function runRemoteAction(
  hooks: ActionHooks,
  label: string,
  pending: Promise<unknown>,
  opts?: { summarize?: boolean; refreshFirst?: () => Promise<void>; after?: () => void },
): Promise<void> {
  hooks.setLoading(true)
  try {
    const outcome = await callRemote(label, pending)
    if (opts?.refreshFirst) await opts.refreshFirst()
    if (outcome.ok) {
      hooks.setNotice(`${label} 完成${opts?.summarize ? summarize(outcome.value) : ''}`)
      hooks.setError(undefined)
      opts?.after?.()
    } else {
      hooks.setNotice(undefined)
      hooks.setError(`${label} 失败：${outcome.error}`)
    }
  } finally {
    hooks.setLoading(false)
  }
}

/** The settings shell's search glyph, inlined so this bundle needs no shared icon package. */
function SearchIcon() {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true },
    h('path', {
      d: 'M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z',
      fill: 'currentColor',
    }),
    h('path', {
      d: 'M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z',
      fill: 'currentColor',
    }),
  )
}

function Btn(props: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return h(
    'button',
    {
      type: 'button',
      className: props.danger ? `${css.btn} ${css.btnDanger}` : css.btn,
      disabled: props.disabled === true,
      onClick: props.onClick,
    },
    props.label,
  )
}

function Field(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** Used by the 「+」 draft so Enter confirms and Escape cancels without reaching for the mouse. */
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  return h(
    'label',
    { className: css.field },
    props.label,
    h('input', {
      className: css.input,
      type: 'text',
      value: props.value,
      placeholder: props.placeholder,
      autoFocus: props.autoFocus === true,
      onKeyDown: props.onKeyDown,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => { props.onChange(e.target.value) },
    }),
  )
}

/**
 * The 知识域 control.
 *
 * With a configured `knowledge.domains` allowlist the host returns `restricted: true` and this is
 * a closed `<select>` over the allowlist ∪ the library's existing domains — a new domain is then a
 * config change, not a second spelling. An explicitly empty allowlist means "no restriction", so
 * the control stays a free input (the host's options still show what is already in use).
 *
 * The WRITE form passes `onAdd`, which adds a 「+」 on the field's own LABEL row, right-aligned with
 * the select: adding a domain is a user action (the agent stays bounded by the configured list), so
 * the picker must not force a hand-edit of YAML. It is deliberately absent while the allowlist is
 * `[]`: appending to an unfettered list would silently turn "no restriction" into a restricted one.
 *
 * The control carries NO explanatory sentence: the field sits in a row of sibling filters, and one
 * extra line under the select made that row taller than its neighbours. The 「+」 says what it does.
 */
function DomainField(props: {
  label: string
  value: string
  onChange: (v: string) => void
  catalog: DomainCatalog | null
  /** The label of the empty choice: `全部` for a filter, `请选择知识域` for a write. */
  emptyLabel: string
  placeholder?: string
  /**
   * Present ONLY on the write form. Persists the name and resolves with an error text, or
   * `undefined` on success; on success the component selects it. The store is the real guard, this
   * callback is the only thing that writes.
   */
  onAdd?: (domain: string) => Promise<string | undefined>
}) {
  const [adding, setAdding] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [addError, setAddError] = React.useState<string | undefined>()
  const [addBusy, setAddBusy] = React.useState(false)

  if (domainPickerMode(props.catalog) === 'input') {
    return h(Field, { label: props.label, value: props.value, onChange: props.onChange, placeholder: props.placeholder })
  }
  const domains = props.catalog?.domains ?? []
  const closeAdd = (): void => { setAdding(false); setDraft(''); setAddError(undefined) }
  const submitAdd = (): void => {
    const check = checkNewDomain(draft, domains)
    if (check.kind === 'empty') { setAddError('知识域不能为空'); return }
    if (check.kind === 'invalid') { setAddError(check.reason); return }
    // Already offered by the picker: select it, write nothing (a duplicate entry helps no one).
    if (check.kind === 'existing') { props.onChange(check.name); closeAdd(); return }
    const onAdd = props.onAdd
    if (onAdd === undefined) return
    setAddBusy(true)
    void onAdd(check.name).then((addFailure) => {
      setAddBusy(false)
      if (addFailure !== undefined) { setAddError(addFailure); return }
      props.onChange(check.name)
      closeAdd()
    })
  }
  // The 「+」 rides the LABEL row and is right-aligned with the select under it: it acts on this one
  // field, whereas as a sibling of the field it read as another toolbar item and wrapped onto a line
  // of its own. While the draft is open the row keeps just the name — the 「+」 has become the form
  // below it.
  const addButton = props.onAdd === undefined || adding
    ? null
    : h(Btn, { label: '+ 新增领域', onClick: () => { setAdding(true) } })
  return h(
    React.Fragment,
    null,
    h(
      'label',
      { className: css.field, key: 'domain' },
      h(
        'span',
        { className: css.fieldHead },
        h('span', null, props.label),
        addButton,
      ),
      h(
        'select',
        {
          className: css.input,
          value: props.value,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { props.onChange(e.target.value) },
        },
        domainOptions(props.catalog, props.emptyLabel).map(option => h('option', { key: option.value, value: option.value }, option.label)),
      ),
    ),
    props.onAdd === undefined || !adding ? null : [
      h(Field, {
        key: 'add-input',
        label: '新知识域（domain）',
        value: draft,
        onChange: (value: string) => { setDraft(value); setAddError(undefined) },
        placeholder: '如 legal',
        autoFocus: true,
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') { e.preventDefault(); submitAdd() }
          else if (e.key === 'Escape') { e.preventDefault(); closeAdd() }
        },
      }),
      h(Btn, { key: 'add-ok', label: addBusy ? '新增中…' : '确定', disabled: addBusy, onClick: submitAdd }),
      h(Btn, { key: 'add-cancel', label: '取消', onClick: closeAdd }),
      addError === undefined ? null : h('span', { key: 'add-error', className: css.error }, addError),
    ],
  )
}

// ─── tab A: 记忆 ──────────────────────────────────────────────────────────

function MemoryPanel(props: { remote?: AvantfRemote }) {
  const [statusFilter, setStatusFilter] = React.useState<'active' | 'archived'>('active')
  const [rows, setRows] = React.useState<FactSummary[]>([])
  const [total, setTotal] = React.useState<number | undefined>()
  const [truncated, setTruncated] = React.useState(false)
  /**
   * How many rows the HOST has handed over — the pagination anchor. It is not `rows.length`:
   * appends are de-duplicated (a row inserted between two page requests shifts the window and
   * repeats one row), and using the de-duplicated length as the next offset would re-request it.
   */
  const [nextOffset, setNextOffset] = React.useState(0)
  const [error, setError] = React.useState<string | undefined>()
  const [notice, setNotice] = React.useState<string | undefined>()
  const [loading, setLoading] = React.useState(props.remote !== undefined)
  const [editing, setEditing] = React.useState<{ id: number; text: string } | null>(null)
  const [detail, setDetail] = React.useState<{ id: number; data: FactDetail } | null>(null)
  const [contradictions, setContradictions] = React.useState<ContradictionRecord[] | null>(null)
  const [health, setHealth] = React.useState<StatsSummary | null>(null)
  // Response-ordering guards: a slow reply must never overwrite a newer one.
  const detailGuard = useSeqGuard()
  const contradictionGuard = useSeqGuard()
  const healthGuard = useSeqGuard()
  // The list needs one too, and more than the others: the scroll observer calls `load` without any
  // user action, so a page requested for 活动 can land after the user switched to 归档 — appending
  // active rows to the archived list and overwriting its total with the active one's.
  const listGuard = useSeqGuard()

  /**
   * Load one page and append it (offset 0 replaces the list). Resolves once the
   * page settled, so callers can order their own state updates after the refresh.
   */
  const load = React.useCallback(async (offset: number, status: 'active' | 'archived'): Promise<void> => {
    if (props.remote === undefined) return
    const seq = listGuard.begin()
    setLoading(true)
    // Only a REFRESH clears the error line. An append is triggered by scrolling, and clearing it
    // there made a mutation's failure message disappear the moment the user scrolled — the
    // mutation path documents the opposite intent (see `mutate`'s refreshFirst).
    if (offset === 0) setError(undefined)
    const outcome = await callRemote<FactPage>(
      `admin.list(status=${status}, offset=${String(offset)})`,
      props.remote.admin({ action: 'list', status, limit: MEMORY_PAGE_SIZE, offset }),
    )
    if (!listGuard.isCurrent(seq)) return // a newer page (or a status switch) already won
    if (outcome.ok) {
      // `?.` / `?? []` / `=== true` stay defensive on purpose: the contract type describes the
      // CURRENT host, while the wire can be an older one (or a gateway that hands back a bare
      // payload). Naming the shape must not turn a tolerated payload into a thrown render.
      const page = outcome.value?.facts ?? []
      setRows(previous => (offset === 0 ? page : mergePage(previous, page)))
      setNextOffset(offset + page.length)
      setTotal(outcome.value?.total)
      setTruncated(outcome.value?.truncated === true)
    } else {
      if (offset === 0) {
        setRows([])
        setNextOffset(0)
        setTotal(undefined)
        setTruncated(false) // never leave "加载更多" over an emptied list
      }
      setError(outcome.error)
    }
    setLoading(false)
  }, [listGuard, props.remote])

  React.useEffect(() => { void load(0, statusFilter) }, [load, statusFilter])

  /** Switch the status tab: clear the other tab's page immediately, and drop its in-flight page. */
  const switchStatus = (next: 'active' | 'archived'): void => {
    if (next === statusFilter) return
    listGuard.begin() // the page already in flight belongs to the tab being left
    setRows([])
    setNextOffset(0)
    setTotal(undefined)
    setTruncated(false)
    setDetail(null)
    setEditing(null)
    // Closing the conflict table must also drop a reply that is still in flight, or that reply
    // re-opens it (see `fetchContradictions`).
    contradictionGuard.begin()
    setContradictions(null)
    setStatusFilter(next)
  }

  /** Run one mutation, refresh page 0, then surface the mutation's own outcome. */
  const mutate = React.useCallback((
    label: string,
    call: (remote: AvantfRemote) => Promise<unknown>,
    opts?: { summarize?: boolean; after?: () => void },
  ) => {
    const remote = props.remote
    if (remote === undefined) return
    // refreshFirst: `load` clears the error line at its start, so the mutation's
    // own error/notice survives (it used to be erased by the refresh's success path).
    void runRemoteAction({ setLoading, setNotice, setError }, label, call(remote), {
      summarize: opts?.summarize,
      refreshFirst: () => load(0, statusFilter),
      // `after` runs once the refresh settled — a second view that the mutation also changed
      // (e.g. the conflict list after a verdict) refreshes here instead of racing the first.
      after: opts?.after,
    })
  }, [props.remote, load, statusFilter])

  const showDetail = (factId: number): void => {
    if (props.remote === undefined) return
    if (detail?.id === factId) { setDetail(null); return }
    const seq = detailGuard.begin()
    void callRemote<FactDetail | { error?: string }>(`admin.detail(${String(factId)})`, props.remote.admin({ action: 'detail', fact_id: factId }))
      .then((outcome) => {
        if (!detailGuard.isCurrent(seq)) return // a newer click already answered
        if (!outcome.ok) { setError(outcome.error); return }
        // `admin.detail` reports a missing fact as `{error}` (a successful call with an error
        // body) — render the error, not an empty panel. Narrowing on `fact_id` is what makes the
        // cast unnecessary: the error body has no such field, so the payload is typed afterwards.
        const value = outcome.value
        if (value === null || typeof value !== 'object' || !('fact_id' in value)) {
          const reason = 'error' in value && typeof value.error === 'string' ? value.error : '详情为空'
          setError(`详情读取失败：${reason}`)
          return
        }
        setDetail({ id: factId, data: value })
      })
  }

  /** Load the open conflicts. Separate from the toggle so a verdict can re-read the list. */
  const fetchContradictions = React.useCallback((): void => {
    const remote = props.remote
    if (remote === undefined) return
    const seq = contradictionGuard.begin()
    void callRemote<ContradictionRecord[]>('recall.contradict', remote.recall({ action: 'contradict', limit: 20 }))
      .then((outcome) => {
        if (!contradictionGuard.isCurrent(seq)) return
        if (outcome.ok) { setContradictions(Array.isArray(outcome.value) ? outcome.value : []); setError(undefined) }
        else setError(outcome.error)
      })
  }, [props.remote, contradictionGuard])

  const loadContradictions = (): void => {
    if (props.remote === undefined) return
    if (contradictions !== null) {
      // Closing must also invalidate a reply already in flight: `useSeqGuard` only advances on
      // `begin()`, so without this a slow `recall.contradict` re-opens the table the user just closed.
      contradictionGuard.begin()
      setContradictions(null)
      return
    }
    fetchContradictions()
  }

  /**
   * Adjudicate one conflict from the page.
   *
   * Naming a loser ARCHIVES that fact (it leaves the live corpus), so those two buttons are
   * marked dangerous while `误报` — which changes no fact — is not. `after` re-reads the list:
   * the row is gone from it, and without the refresh the table would still show a closed pair.
   */
  const resolveConflict = (row: ContradictionRecord, resolution: 'true_positive' | 'false_positive', loserFactId?: number): void => {
    mutate(
      resolution === 'false_positive'
        ? `标记矛盾 #${String(row.contradiction_id)} 为误报`
        : `裁决矛盾 #${String(row.contradiction_id)}（归档 #${String(loserFactId)}）`,
      remote => remote.admin({
        action: 'contradict_resolve',
        contradiction_id: row.contradiction_id,
        resolution,
        loser_fact_id: loserFactId,
      }),
      { after: fetchContradictions },
    )
  }

  const loadHealth = (): void => {
    if (props.remote === undefined) return
    if (health !== null) {
      healthGuard.begin() // same as the conflict table: a late stats reply must not reopen it
      setHealth(null)
      return
    }
    const seq = healthGuard.begin()
    void callRemote<StatsSummary>('admin.stats', props.remote.admin({ action: 'stats' }))
      .then((outcome) => {
        if (!healthGuard.isCurrent(seq)) return
        if (outcome.ok) { setHealth(outcome.value); setError(undefined) }
        else setError(outcome.error)
      })
  }

  const shown = rows.length
  const summary = total === undefined
    ? `已显示 ${String(shown)} 条`
    : `共 ${String(total)} 条${statusFilter === 'active' ? '活动' : '归档'}事实，已显示 ${String(shown)} 条`
      + (truncated ? '（继续滚动自动加载）' : '')

  /** Bring the panel's top into view — used when a block opens below the sticky bar. */
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const reveal = (): void => { rootRef.current?.scrollIntoView({ block: 'start' }) }
  // Mounting inside a scrollport that kept its offset (the seat swaps only the view child) would
  // drop the panel in at whatever depth the previous view was scrolled to — with the sticky bar's
  // controls and the top of the list already above the fold. Start at the panel's own top.
  React.useEffect(() => { reveal() }, [])

  /** Load the next page once the list's end is within reach of the scrollport. */
  const maybeLoadMore = (): void => {
    if (!truncated || loading || props.remote === undefined) return
    void load(nextOffset, statusFilter)
  }
  useLoadMoreOnScroll(rootRef, truncated && !loading, maybeLoadMore, rows.length)

  // Mounting inside a scrollport that kept its offset (the seat swaps only the view child) would
  // drop the panel in at whatever depth the previous view was scrolled to — with the sticky bar's

  return h(
    'div',
    { className: css.section, ref: rootRef },
    props.remote === undefined ? h('div', { className: css.error }, NOT_MOUNTED) : null,
    props.remote === undefined ? null : h('div', { className: css.headbar },
      h('button', {
        type: 'button',
        className: statusFilter === 'active' ? `${css.btn} ${css.btnActive}` : css.btn,
        onClick: () => { switchStatus('active') },
      }, '活动'),
      h('button', {
        type: 'button',
        className: statusFilter === 'archived' ? `${css.btn} ${css.btnActive}` : css.btn,
        onClick: () => { switchStatus('archived') },
      }, '归档'),
      h(Btn, {
        label: '立即维护',
        disabled: loading,
        onClick: () => { mutate('生命周期维护', remote => remote.admin({ action: 'maintenance' })) },
      }),
      // These two used to sit BELOW the list, so with a long list they were only
      // reachable after scrolling to the end. They belong in the sticky bar with the
      // rest of the controls, and opening one scrolls the panel back to the top so
      // the block that just appeared is in view instead of above the scrollport.
      h(Btn, {
        label: contradictions === null ? '查看未处理矛盾' : '收起矛盾',
        disabled: loading,
        onClick: () => { const opening = contradictions === null; loadContradictions(); if (opening) reveal() },
      }),
      h(Btn, {
        label: health === null ? '查看检索健康度' : '收起检索健康度',
        disabled: loading,
        onClick: () => { const opening = health === null; loadHealth(); if (opening) reveal() },
      }),
      h('div', { className: css.status }, loading && shown === 0 ? '读取中…' : summary),
    ),
    error !== undefined ? h('div', { className: css.error }, `错误：${error}`) : null,
    notice !== undefined ? h('div', { className: css.status }, notice) : null,
    props.remote !== undefined && !loading && error === undefined && shown === 0
      ? h('div', { className: css.status }, statusFilter === 'active'
        ? '当前没有活动的事实。可在对话里让 agent 用 mem_remember 写入。'
        : '当前没有归档的事实。')
      : null,
    // Opened blocks render ABOVE the list, directly under the sticky bar: they are
    // read right after the click, not after scrolling past every fact.
    health !== null ? h(HealthBlock, { stats: health }) : null,
    contradictions !== null
      ? contradictions.length === 0
        ? h('div', { className: css.status }, '没有未处理的矛盾。')
        : h('ul', { className: css.list }, contradictions.map(c => h(
          'li',
          { key: c.contradiction_id, className: css.item },
          `#${String(c.fact_a)}「${c.content_a}」 ↔ #${String(c.fact_b)}「${c.content_b}」`,
          h('span', { className: css.meta }, `score ${c.score.toFixed(2)} · ${c.detected_at ?? ''}`),
          props.remote !== undefined
            ? h('div', { className: css.row },
              h(Btn, { label: `判 #${String(c.fact_a)} 错`, danger: true, disabled: loading, onClick: () => resolveConflict(c, 'true_positive', c.fact_a) }),
              h(Btn, { label: `判 #${String(c.fact_b)} 错`, danger: true, disabled: loading, onClick: () => resolveConflict(c, 'true_positive', c.fact_b) }),
              h(Btn, { label: '误报（两条都对）', disabled: loading, onClick: () => resolveConflict(c, 'false_positive') }),
            )
            : null,
        )))
      : null,
    h('ul', { className: css.list }, rows.map(f => h(
      'li',
      { key: f.fact_id, className: css.item },
      editing?.id === f.fact_id
        ? h('textarea', {
          className: css.textarea,
          value: editing.text,
          rows: 3,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setEditing({ id: f.fact_id, text: e.target.value }) },
        })
        : f.content,
      h('span', { className: css.meta },
        `#${String(f.fact_id)} · ${f.category} · trust ${f.trust_score.toFixed(2)}`
        + (f.pinned === true
          ? ' · 永久'
          : typeof f.remaining_days === 'number' ? ` · 剩余 ≈${String(Math.ceil(f.remaining_days))} 活跃日` : '')
        + ` · 有用 ${String(f.helpful_count)} · ${f.created_at}`
        + (f.status === 'archived' && f.archive_reason ? ` · 归档原因 ${f.archive_reason}` : '')
        // R12 limbo, stated honestly: a permanent fact archived by an explicit TTL is
        // never purged, so it leaves the active set but stays in the store forever.
        + (f.status === 'archived' && f.pinned === true ? ' · 永久保留（不会被清理）' : '')),
      h('div', { className: css.row },
        editing?.id === f.fact_id
          ? [
            h(Btn, {
              key: 'save',
              label: '保存',
              disabled: loading || editing.text.trim().length === 0,
              onClick: () => {
                const text = editing.text.trim()
                setEditing(null)
                // summarize: an edit is the one page-side write that can be detected as a
                // CONFLICT at write time, and the notice is where the page can say so.
                mutate(
                  `更新 #${String(f.fact_id)}`,
                  remote => remote.remember({ action: 'update', fact_id: f.fact_id, content: text }),
                  { summarize: true },
                )
              },
            }),
            h(Btn, { key: 'cancel', label: '取消', disabled: loading, onClick: () => { setEditing(null) } }),
          ]
          : [
            h(Btn, { key: 'detail', label: detail?.id === f.fact_id ? '收起详情' : '详情', disabled: loading, onClick: () => { showDetail(f.fact_id) } }),
            statusFilter === 'active'
              ? h(Btn, { key: 'edit', label: '编辑', disabled: loading, onClick: () => { setEditing({ id: f.fact_id, text: f.content }); setDetail(null) } })
              : null,
            statusFilter === 'active'
              ? h(Btn, { key: 'helpful', label: '有用 +1', disabled: loading, onClick: () => { mutate(`反馈有用 #${String(f.fact_id)}`, remote => remote.remember({ action: 'helpful', fact_id: f.fact_id })) } })
              : null,
            statusFilter === 'active'
              ? h(Btn, { key: 'unhelpful', label: '没用 −1', disabled: loading, onClick: () => { mutate(`反馈没用 #${String(f.fact_id)}`, remote => remote.remember({ action: 'unhelpful', fact_id: f.fact_id })) } })
              : null,
            statusFilter === 'active'
              ? h(Btn, { key: 'archive', label: '归档', disabled: loading, onClick: () => { mutate(`归档 #${String(f.fact_id)}`, remote => remote.admin({ action: 'archive', fact_id: f.fact_id, reason: 'ui' })) } })
              : h(Btn, { key: 'restore', label: '恢复', disabled: loading, onClick: () => { mutate(`恢复 #${String(f.fact_id)}`, remote => remote.admin({ action: 'restore', fact_id: f.fact_id })) } }),
            statusFilter === 'active'
              ? (f.pinned === true
                ? h(Btn, { key: 'unpin', label: '解除永久', disabled: loading, onClick: () => { mutate(`解除永久 #${String(f.fact_id)}`, remote => remote.admin({ action: 'unpin', fact_id: f.fact_id })) } })
                : h(Btn, { key: 'pin', label: '永久记忆', disabled: loading, onClick: () => { mutate(`固化永久 #${String(f.fact_id)}`, remote => remote.admin({ action: 'pin', fact_id: f.fact_id })) } }))
              : null,
          ],
      ),
      detail?.id === f.fact_id
        ? h('div', { className: css.meta },
          // 列表行只显示 created_at（第一次记录的时间）；详情才并列两个时间，避免把
          // 「这一行被改过」误读成「内容更新」。
          `创建于 ${detail.data.created_at} / 更新于 ${detail.data.updated_at ?? '—'}`,
          h('br'),
          `实体：${(detail.data.entities ?? []).join('、') || '（无）'}`,
          h('br'),
          `三元组：${(detail.data.triples ?? []).map(t => `${t.subj} —${t.pred}→ ${t.obj}（${t.confidence.toFixed(2)}）`).join('；') || '（无）'}`,
          h('br'),
          `检索次数：${String(detail.data.retrieval_count ?? 0)}${detail.data.supersedes_id ? ` · 修订自 #${String(detail.data.supersedes_id)}` : ''}`)
        : null,
    ))),
    truncated
      ? h(
        'button',
        {
          type: 'button',
          className: css.more,
          disabled: loading,
          onClick: () => { load(nextOffset, statusFilter) },
        },
        loading
          ? '加载中…'
          : total === undefined
            ? '加载更多'
            : `加载更多（还有 ${String(Math.max(total - shown, 0))} 条）`,
      )
      : null,
  )
}

/**
 * Retrieval health (DESIGN §20): the numbers that say whether retrieval is actually working —
 * how often it is degraded, how often it returns nothing, and whether a budget has been cutting
 * text. They live in memory and are flushed to `avantf_stats`, so they survive a restart.
 */
function HealthBlock(props: { stats: StatsSummary }) {
  const r = props.stats.retrieval
  if (r === undefined) return h('div', { className: css.status }, '检索健康度不可用。')
  // The DETECTION half of "changing the embedding space is a data migration": without it, a model
  // upgrade degraded every semantic query while this panel kept reporting a healthy retrieval rate.
  // Optional (`undefined` against a host from before the field existed) so an older host still renders.
  const vectors = props.stats.vectors
  const pendingVectors = vectors === undefined ? 0 : vectors.stale + vectors.space_stale
  const pct = (v: number): string => `${String(Math.round(v * 100))}%`
  const kinds = Object.entries(r.by_kind)
    .map(([kind, v]) => `${kind} ${String(v.queries)} 次（空 ${String(v.zero_results)}）`)
    .join(' · ')
  const truncated = r.embedding_truncated + r.rerank_truncated + r.output_truncated
  return h('div', { className: css.detail },
    pendingVectors === 0
      ? null
      : h('div', { className: css.status },
        `⚠ 向量空间待迁移：${String(pendingVectors)} 条 ACTIVE 向量来自旧嵌入空间`
        + `（宽度不符 ${String(vectors?.stale ?? 0)} · 其他模型 ${String(vectors?.space_stale ?? 0)}）`
        + '——语义腿对它们失效，正在后台分批重算；手动入口 `avantf-mem vectors --fix`'),
    h('div', { className: css.status },
      `检索 ${String(r.queries)} 次 · 空结果 ${pct(r.zero_result_rate)} · 平均 ${r.avg_latency_ms.toFixed(1)}ms · 峰值 ${r.max_latency_ms.toFixed(1)}ms`),
    h('div', { className: css.meta },
      `语义腿在线 ${pct(r.semantic_live_rate)} · 平均命中 ${String(r.avg_results_per_query)} 条${r.rerank_used > 0 ? ` · 重排 ${String(r.rerank_used)} 次` : ''}`),
    kinds === '' ? null : h('div', { className: css.meta }, kinds),
    h('div', { className: css.meta },
      truncated === 0
        ? '未被任何预算截断。'
        : `截断：嵌入 ${String(r.embedding_truncated)} · 重排 ${String(r.rerank_truncated)} · 输出 ${String(r.output_truncated)}${r.output_truncated > 0 ? '（调大 retrieval.max_output_tokens 或用 max_tokens 参数）' : ''}`),
    r.updated_at === null ? null : h('div', { className: css.meta }, `更新于 ${r.updated_at}`),
  )
}

// ─── tab B: 知识 + KB 管理 ─────────────────────────────────────────────────

/**
 * Group cross-store hits for display: memory facts vs `domain → source`.
 *
 * Reads the host's `domain`/`source` fields. Splitting `source_ref` here (the old
 * `parts[0] → parts[1]`) mis-grouped any document whose domain or source name
 * contains `:` — the host cannot encode the pair unambiguously either way.
 */
function groupKey(hit: RecallHit): string {
  if (hit.kind === 'fact') return '记忆事实'
  const domain = hit.domain ?? ''
  const source = hit.source ?? ''
  if (domain !== '' && source !== '') return `${domain} → ${source}`
  return domain || source || '文档切片'
}

/**
 * How many candidates one reply's relevance floors removed, across every leg.
 *
 * This is the difference between the two readings of an empty result ("the floors removed N" vs
 * "there was nothing to remove"), and it is what makes the panel's 宽松 hint actionable rather than
 * a suggestion to retry blindly.
 */
function droppedByFloor(value: RecallResult): number {
  const drops = value.dropped_by_floor
  if (drops === undefined) return 0
  return drops.semantic + drops.fts + drops.jaccard + drops.hrr
}

function KnowledgePanel(props: { remote?: AvantfRemote }) {
  // The document list is the page body; 查询 is a panel opened on demand, so nothing
  // here queries the store until the user asks for it.
  const [showQuery, setShowQuery] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState('all')
  /**
   * The relevance-floor profile (contract `FLOOR_PROFILES`): 严格 = the configured floors with NO
   * automatic fallback, 宽松 = the relaxed floors. Default 严格 — the panel must not silently trade
   * precision for recall, and sending `strict` explicitly is what makes the empty-result hint
   * actionable ("N were dropped, switch to 宽松") instead of the retry having already happened.
   * The value is always sent; an omitted profile is the engine's default policy (auto-relax once),
   * which the 严格/宽松 labels would misdescribe.
   */
  const [floors, setFloors] = React.useState('strict')
  const [domain, setDomain] = React.useState('')
  const [source, setSource] = React.useState('')
  const [hits, setHits] = React.useState<RecallHit[]>([])
  /** Candidates the last reply's floors removed; drives the 宽松 hint on an empty result. */
  const [floorDropped, setFloorDropped] = React.useState(0)
  const [queryStatus, setQueryStatus] = React.useState('输入关键词后按回车检索')
  const [error, setError] = React.useState<string | undefined>()
  const [notice, setNotice] = React.useState<string | undefined>()
  const [loading, setLoading] = React.useState(false)
  /** The 查询 call's own in-flight flag — `loading` belongs to the KB mutations. */
  const [queryLoading, setQueryLoading] = React.useState(false)

  // KB state — the document list is what the tab shows on open.
  const [docs, setDocs] = React.useState<DocumentSummary[] | null>(null)
  const [docDetail, setDocumentDetail] = React.useState<{ id: number; data: DocumentDetail } | null>(null)
  /**
   * The managed files as the host last saw them (`kb sync --dry-run`): which documents' `.md` was
   * edited since it was ingested, which have no file at all, and which files no document claims.
   * Read together with the list — there is deliberately no file watcher (changes are pulled in on
   * demand), so these flags are what tells the user a 「重新摄入」 is due.
   */
  const [fileState, setFileState] = React.useState<Pick<KbSyncReport, 'stale' | 'missing' | 'orphans' | 'unclaimed'> | null>(null)
  /** Pagination anchor for the document list (rows the host has handed over) + "there may be more". */
  const [docsOffset, setDocsOffset] = React.useState(0)
  const [docsTruncated, setDocsTruncated] = React.useState(false)
  const [showIngest, setShowIngest] = React.useState(false)
  const [iDomain, setIDomain] = React.useState('')
  const [iSource, setISource] = React.useState('')
  const [iTitle, setITitle] = React.useState('')
  const [iText, setIText] = React.useState('')
  /**
   * The 知识域 options the host reported: the configured allowlist ∪ the domains already in the
   * library, plus whether the allowlist is active. `null` = not fetched yet (or the call failed),
   * which falls back to the free input rather than blocking the form.
   */
  const [domainCatalog, setDomainCatalog] = React.useState<DomainCatalog | null>(null)
  /**
   * ONE source input (URL / local file / local directory / pasted text). What it IS can only be
   * answered by the host, so `sourceInfo` holds its classification and the hint line shows what
   * 入库 will do before it is pressed.
   */
  const [iUri, setIUri] = React.useState('')
  const [sourceInfo, setSourceInfo] = React.useState<SourceClassification | null>(null)
  /**
   * Which of the two inputs the form is showing. They are alternatives, not a sequence: document
   * identity is `(domain, source, title)`, so ingesting a file AND pasted text under one title would
   * make the second call REPLACE the first. Rather than pick one silently (or lose a document),
   * only one input exists at a time; the other keeps its value and is marked 有内容 on the toggle.
   */
  const [inputMode, setInputMode] = React.useState<'source' | 'text'>('source')
  /** The 选择 picker: `null` closed, otherwise the current listing (or an error to show). */
  const [picker, setPicker] = React.useState<{ listing: BrowseListing | null; error?: string } | null>(null)
  const docsGuard = useSeqGuard()
  const docDetailGuard = useSeqGuard()
  // The query had no guard while `docs`/`detail` did: two Enters issued two `remote.query` calls,
  // both wrote `hits`, and whichever settled FIRST cleared the shared `loading` — enabling the KB
  // buttons while a query was still in flight. Guard + its own flag.
  const queryGuard = useSeqGuard()

  const run = (): void => {
    const remote = props.remote
    if (remote === undefined) return
    const text = query.trim()
    if (text.length === 0) {
      setQueryStatus('请输入查询关键词')
      setHits([])
      setFloorDropped(0)
      setError(undefined)
      return
    }
    const seq = queryGuard.begin()
    setQueryLoading(true)
    void callRemote<RecallResult>('query', remote.query({
      query: text,
      kind,
      domain: domain.trim() || undefined,
      source: source.trim() || undefined,
      limit: 10,
      floors,
    }))
      .then((outcome) => {
        if (!queryGuard.isCurrent(seq)) return // a newer Enter already owns the panel
        if (outcome.ok) {
          const value = outcome.value
          const found = value?.hits ?? []
          setHits(found)
          setFloorDropped(value === undefined ? 0 : droppedByFloor(value))
          const degraded = value?.degraded === true ? '（语义降级，仅 FTS+实体）' : ''
          // The profile and the engine's automatic fallback are both stated: a relaxed answer sits
          // below the configured relevance bar and must not read like a strict one.
          const profile = value?.relaxed === true ? '（已自动放宽门槛）' : floors === 'loose' ? '（宽松门槛）' : ''
          setQueryStatus(`命中 ${String(found.length)} 条${profile}${degraded}`)
          setError(undefined)
        } else {
          setHits([])
          setFloorDropped(0)
          setQueryStatus('查询失败')
          setError(outcome.error)
        }
      })
      .finally(() => { if (queryGuard.isCurrent(seq)) setQueryLoading(false) })
  }

  const kbCall = (label: string, args: Record<string, unknown>, after?: () => void): void => {
    const remote = props.remote
    if (remote === undefined) return
    void runRemoteAction({ setLoading, setNotice, setError }, label, remote.kb(args), { summarize: true, after })
  }

  const loadDocs = React.useCallback((offset: number): void => {
    const remote = props.remote
    if (remote === undefined) return
    const seq = docsGuard.begin()
    // No domain/source here on purpose: the tab's body is the WHOLE knowledge base, while
    // those two fields belong to 查询 (and scope 重建索引). Feeding them in would also make
    // this effect re-fire on every keystroke of the query panel's filter inputs.
    void callRemote<DocumentSummary[]>('kb.list', remote.kb({ action: 'list', limit: DOC_PAGE_SIZE, offset }))
      .then((outcome) => {
        if (!docsGuard.isCurrent(seq)) return
        if (outcome.ok) {
          const page = Array.isArray(outcome.value) ? outcome.value : []
          setDocs(previous => (offset === 0 || previous === null ? page : mergeDocs(previous, page)))
          setDocsOffset(offset + page.length)
          // The payload is a bare array, so "there may be more" is "the page was full" — one extra
          // request at the end, in exchange for not changing a shape the CLI and MCP surfaces read.
          setDocsTruncated(page.length === DOC_PAGE_SIZE)
          setError(undefined)
        } else {
          setError(outcome.error)
        }
      })
  }, [props.remote])

  // The list IS the page: read it on mount (and whenever the remote mounts). No
  // "展开知识库" gate — the button that used to open this list is gone, so switching to
  // the tab shows documents immediately. Mutations refresh it explicitly after they land.
  React.useEffect(() => { loadDocs(0) }, [loadDocs])

  /** Re-read each document's managed file state (`kb sync --dry-run` — never re-ingests). */
  const loadFiles = React.useCallback((): void => {
    const remote = props.remote
    if (remote === undefined) return
    void callRemote<KbSyncReport>('kb.sync(dry_run)', remote.kb({ action: 'sync', dry_run: true }))
      .then((outcome) => {
        if (outcome.ok) {
          setFileState({
            stale: outcome.value?.stale ?? [],
            missing: outcome.value?.missing ?? [],
            unclaimed: outcome.value?.unclaimed ?? [],
            orphans: outcome.value?.orphans ?? [],
          })
        } else {
          setError(outcome.error)
        }
      })
  }, [props.remote])

  React.useEffect(() => { loadFiles() }, [loadFiles])

  /** The domain picker's options: fetched once on mount and again whenever the library changes. */
  const loadDomains = React.useCallback((): void => {
    const remote = props.remote
    if (remote === undefined) return
    void callRemote<DomainCatalog>('kb.domains', remote.kbDomains({}))
      .then((outcome) => {
        if (outcome.ok && outcome.value) setDomainCatalog(outcome.value)
        else if (!outcome.ok) setError(outcome.error)
      })
  }, [props.remote])

  React.useEffect(() => { loadDomains() }, [loadDomains])

  /**
   * The write form's 「+」: append one domain to the store config through the UI-only remote
   * method, then fold the returned catalog into state (the host is the source of truth for the
   * order). Returns the error text for the inline field; `undefined` means it landed and the
   * control selects it.
   */
  const addDomain = (domain: string): Promise<string | undefined> => {
    const remote = props.remote
    if (remote === undefined) return Promise.resolve('未挂载 avantfMem Remote')
    return callRemote<DomainCatalog>('kb.addDomain', remote.kbAddDomain({ domain })).then((outcome) => {
      if (!outcome.ok) return outcome.error
      if (outcome.value) setDomainCatalog(outcome.value)
      setNotice(`已新增知识域「${domain}」并写入知识库配置`)
      setError(undefined)
      return undefined
    })
  }

  /** The list and the file flags always move together — one refresh for both. */
  const refresh = React.useCallback((): void => { loadDocs(0); loadFiles(); loadDomains() }, [loadDocs, loadFiles, loadDomains])

  /**
   * Open one document's managed file (or the directory holding it) in the user's editor.
   * The host resolves the path from `doc_id`; the client only says which of the two.
   */
  const openDoc = (docId: number, target: OpenTarget): void => {
    const remote = props.remote
    if (remote === undefined) return
    void callRemote<OpenOutcome>('kb.openDoc', remote.openDoc({ doc_id: docId, target }))
      .then((outcome) => {
        if (outcome.ok) {
          const opener = outcome.value?.opener ?? '编辑器'
          setNotice(target === 'dir'
            ? `已用 ${opener} 打开目录：${outcome.value?.path ?? ''}`
            : `已用 ${opener} 打开：${outcome.value?.path ?? ''}（改完保存后点「重新摄入」）`)
          setError(undefined)
        } else {
          setError(outcome.error)
        }
      })
  }

  /** Pull edited files back into the index: one document, or every stale one. */
  // `adopt` is the explicit second step for a file whose frontmatter was destroyed by a whole-file
  // overwrite: the store reports it as `unclaimed` and refuses to guess, and this is the user
  // accepting that guess for one document.
  const syncDocs = (docId?: number, adopt?: boolean): void => {
    const remote = props.remote
    if (remote === undefined) return
    setLoading(true)
    void callRemote<KbSyncReport>('kb.sync', remote.kb(docId === undefined
      ? { action: 'sync' }
      : { action: 'sync', doc_id: docId, ...(adopt === true ? { adopt: true } : {}) }))
      .then((outcome) => {
        if (outcome.ok) {
          const report = outcome.value
          const missing = report?.missing.length ?? 0
          setNotice(adopt === true
            ? `认领完成：${String(report?.adopted ?? 0)} 篇`
            : `同步完成：重新摄入 ${String(report?.reingested ?? 0)} 篇`
              + (missing > 0 ? `；${String(missing)} 篇的受管文件不存在（重新摄入可重建）` : ''))
          setError(undefined)
        } else {
          setError(outcome.error)
        }
      })
      .finally(() => { setLoading(false); refresh() })
  }

  /** Bring the panel's top into view — used when a block opens below the sticky bar. */
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const reveal = (): void => { rootRef.current?.scrollIntoView({ block: 'start' }) }
  React.useEffect(() => { reveal() }, []) // same reason as the 记忆 tab: the seat keeps scrollTop

  // The document list pages like the 记忆 list: the same hook, the same scrollport (this panel does
  // not own one), and the same "a full page means there may be more" rule.
  const maybeLoadMoreDocs = (): void => { if (docsTruncated && !loading) loadDocs(docsOffset) }
  useLoadMoreOnScroll(rootRef, docsTruncated && !loading, maybeLoadMoreDocs, docs?.length ?? 0)

  const showDocumentDetail = (docId: number): void => {
    const remote = props.remote
    if (remote === undefined) return
    if (docDetail?.id === docId) { setDocumentDetail(null); return }
    const seq = docDetailGuard.begin()
    void callRemote<DocumentDetail | null>(`kb.detail(${String(docId)})`, remote.kb({ action: 'detail', doc_id: docId }))
      .then((outcome) => {
        if (!docDetailGuard.isCurrent(seq)) return // a newer click already answered
        if (outcome.ok && outcome.value) { setDocumentDetail({ id: docId, data: outcome.value }); setError(undefined) }
        else setError(outcome.ok ? '文档详情为空' : outcome.error)
      })
  }

  /**
   * Ask before deleting a document — its chunks/vectors AND its managed file. The dialog names
   * the file when the last status call knew it, and says outright that `source_uri` is untouched:
   * "delete the document" must never read as "delete my file".
   */
  const confirmRemoveDoc = (doc: DocumentSummary): void => {
    const known = [...(fileState?.stale ?? []), ...(fileState?.missing ?? [])]
      .find(file => file.doc_id === doc.doc_id)
    const message = `删除文档 #${String(doc.doc_id)}「${doc.title}」及其受管文件`
      + (known === undefined ? '（knowledge/docs 下的那份副本）' : `：\n${known.path}`)
      + '\n\n该文档的切片与向量一并删除，此操作不可恢复；source_uri 指向的原文件不会被改动。'
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(message)) return
    kbCall(`删除文档 #${String(doc.doc_id)}`, { action: 'remove', doc_id: doc.doc_id }, () => { setDocumentDetail(null); refresh() })
  }

  // Grouped results (order preserved: first appearance of each group).
  const groups: [string, RecallHit[]][] = []
  for (const hit of hits) {
    const key = groupKey(hit)
    const found = groups.find(g => g[0] === key)
    if (found) found[1].push(hit)
    else groups.push([key, [hit]])
  }

  const sourceText = iUri.trim()
  const bodyText = iText.trim()

  /**
   * Ask the host what the source input is, debounced so typing a path does not fire a stat per
   * keystroke. The answer drives both the hint line and which `kb_manage` action 入库 sends.
   */
  React.useEffect(() => {
    const remote = props.remote
    if (remote === undefined) return undefined
    if (sourceText === '') { setSourceInfo(null); return undefined }
    // Drop the previous verdict IMMEDIATELY: during the debounce plus the round trip the old
    // classification was still rendered and still readable by `canIngest`/`submitIngest`, so a
    // click in that window submitted the PREVIOUS path with no visible sign.
    setSourceInfo(null)
    const timer = setTimeout(() => {
      void callRemote<SourceClassification>('kb.classifySource', remote.classifySource({ text: sourceText }))
        .then((outcome) => {
          if (outcome.ok) setSourceInfo(normalizeClassification(outcome.value))
          else { setSourceInfo(null); setError(outcome.error) }
        })
    }, 300)
    return () => { clearTimeout(timer) }
  }, [sourceText, props.remote])

  /** Load one directory into the picker; `path === undefined` starts at the first allowed root. */
  const browseTo = (path?: string): void => {
    const remote = props.remote
    if (remote === undefined) return
    setPicker(previous => ({ listing: previous?.listing ?? null }))
    void callRemote<BrowseListing>('kb.browseDir', remote.browseDir(path === undefined ? {} : { path }))
      .then((outcome) => {
        if (outcome.ok) setPicker({ listing: outcome.value ?? null })
        else setPicker({ listing: null, error: outcome.error })
      })
  }

  /** Put a picked path into the source input (which re-classifies it) and close the picker. */
  const choosePath = (path: string): void => { setIUri(path); setPicker(null) }

  /** The other input still holds something — say so, so提交 does not silently leave it behind. */
  const inactiveNote = (inputMode === 'source' && bodyText !== '') || (inputMode === 'text' && sourceText !== '')
    ? `（${inputMode === 'source' ? '粘贴文本' : '来源'}里有内容，本次不会入库）`
    : ''

  /** What 入库 will do with what is currently filled in — shown BEFORE it is pressed. */
  const ingestHint = ((): string => {
    if (inputMode === 'text') {
      return bodyText !== '' ? `将「粘贴文本」入库${inactiveNote}` : '粘贴文本后即可入库'
    }
    if (sourceText !== '') {
      const info = sourceInfo
      if (info === null) return '正在识别来源…'
      if (info.kind === 'url') return '将从该 URL 抓取内容入库'
      if (info.kind === 'file') {
        return info.paths.length > 1
          ? `将导入这 ${String(info.paths.length)} 个本地文件`
          : `将按本地文件入库：${info.paths[0] ?? ''}`
      }
      if (info.kind === 'directory') return `将导入该目录（${String(info.files)} 个可摄入文件，其余跳过）`
      if (info.kind === 'missing') {
        return `找不到：${info.missing.join('、')}${info.reasons[0] === undefined ? '' : ` —— ${info.reasons[0]}`}`
      }
      return `将作为文本入库（不是 URL，也不是本地路径）${inactiveNote}`
    }
    return '填写来源后即可入库'
  })()

  /** True when the hint is a refusal rather than a plan — the row turns warning-coloured. */
  const ingestBlocked = inputMode === 'source'
    ? sourceText !== '' && sourceInfo?.kind === 'missing'
    : false

  const canIngest = iDomain.trim().length > 0
    && (inputMode === 'text'
      ? bodyText !== ''
      : sourceText !== '' && sourceInfo !== null && sourceInfo.kind !== 'missing')

  /**
   * One 入库 request, with the collision step built in.
   *
   * The host's REPLACE mode answers an unconfirmed collision with a report and writes NOTHING, so
   * this asks the user first and only then re-runs the SAME request with `overwrite: true`.
   * Cancelling returns without sending a second request — nothing is written either way.
   */
  const ingestCall = (label: string, args: Record<string, unknown>, after: () => void): void => {
    const remote = props.remote
    if (remote === undefined) return
    setLoading(true)
    void callRemote<unknown>(label, remote.kb(args))
      .then((outcome) => {
        if (!outcome.ok) { setNotice(undefined); setError(`${label} 失败：${outcome.error}`); return }
        const conflict = ingestConflict(outcome.value)
        if (conflict === null) {
          setNotice(`${label} 完成${summarize(outcome.value)}`)
          setError(undefined)
          after()
          return
        }
        if (typeof globalThis.confirm !== 'function' || !globalThis.confirm(conflictMessage(conflict))) return
        return callRemote<unknown>(label, remote.kb({ ...args, overwrite: true }))
          .then((retry) => {
            if (!retry.ok) { setNotice(undefined); setError(`${label} 失败：${retry.error}`); return }
            setNotice(`${label} 完成${summarize(retry.value)}`)
            setError(undefined)
            after()
          })
      })
      .finally(() => { setLoading(false) })
  }

  /**
   * One 入库 button, four destinations: a URL is fetched, an existing file is read, a directory is
   * imported, and anything that is neither a URL nor an existing path is ingested as text. The
   * classification that decides this came from the host — never from a client-side guess.
   */
  const submitIngest = (): void => {
    const domain = iDomain.trim()
    // Empty = let the contract default it to `default`; sending `''` would land an empty path
    // segment instead.
    const source = iSource.trim() || undefined
    const title = iTitle.trim() || undefined
    // Only the visible input is consumed; the other keeps whatever it holds for the next attempt.
    const after = (): void => {
      if (inputMode === 'text') setIText('')
      else setIUri('')
      refresh()
    }
    if (inputMode === 'text') {
      ingestCall('入库', { action: 'ingest', text: bodyText, domain, source, title }, after)
      return
    }
    if (sourceText !== '') {
      const info = sourceInfo
      if (info === null || info.kind === 'missing') return
      if (info.kind === 'directory' || info.paths.length > 1) {
        ingestCall('导入', { action: 'import', paths: info.paths, domain, source }, after)
        return
      }
      if (info.kind === 'file') {
        ingestCall('入库', { action: 'ingest', source_uri: info.paths[0], domain, source, title }, after)
        return
      }
      if (info.kind === 'url') {
        ingestCall('入库', { action: 'ingest', source_uri: sourceText, domain, source, title }, after)
        return
      }
    }
    ingestCall('入库', { action: 'ingest', text: sourceText, domain, source, title }, after)
  }

  const shown = docs?.length ?? 0
  const staleIds = new Set((fileState?.stale ?? []).map(file => file.doc_id))
  const missingIds = new Set((fileState?.missing ?? []).map(file => file.doc_id))
  const unclaimedIds = new Set((fileState?.unclaimed ?? []).map(file => file.doc_id))
  const orphans = fileState?.orphans.length ?? 0
  const summary = docs === null
    ? '读取中…'
    : `已加载 ${String(shown)} 篇文档${docsTruncated ? '（继续滚动自动加载）' : ''}`
      + (staleIds.size > 0 ? ` · ${String(staleIds.size)} 篇待重新摄入` : '')
      + (orphans > 0 ? ` · ${String(orphans)} 个无主文件` : '')

  return h(
    'div',
    { className: css.section, ref: rootRef },
    props.remote === undefined ? h('div', { className: css.error }, NOT_MOUNTED) : null,
    // Sticky bar, the same shape as the 记忆 tab: the page body is a long list, so its
    // controls must not scroll away with it. The button that used to open the list is
    // gone — the list is what this tab shows.
    props.remote === undefined ? null : h('div', { className: css.headbar },
      h(Btn, {
        label: showQuery ? '收起查询' : '查询',
        disabled: loading,
        onClick: () => { const opening = !showQuery; setShowQuery(!showQuery); if (opening) reveal() },
      }),
      h(Btn, {
        label: showIngest ? '收起入库' : '入库',
        disabled: loading,
        // The form mounts ABOVE the document list, so opening it must bring the top into view —
        // otherwise the only visible change is the button's own label.
        onClick: () => { const opening = !showIngest; setShowIngest(opening); if (opening) reveal() },
      }),
      h(Btn, {
        label: staleIds.size > 0 ? `同步文件（${String(staleIds.size)}）` : '同步文件',
        disabled: loading || staleIds.size === 0,
        onClick: () => { syncDocs() },
      }),
      h(Btn, {
        label: domain.trim() ? `重建索引（${domain.trim()}）` : '重建索引',
        disabled: loading,
        onClick: () => { kbCall('重建索引', { action: 'reindex', domain: domain.trim() || undefined }, refresh) },
      }),
      h('div', { className: css.status }, loading ? '处理中…' : summary),
    ),
    error !== undefined ? h('div', { className: css.error }, `错误：${error}`) : null,
    notice !== undefined ? h('div', { className: css.status }, notice) : null,

    // ─── 查询框：点「查询」才出现（展开即聚焦输入框，回车即检索） ───
    showQuery
      ? h('div', { className: css.item },
        React.createElement(
          'label',
          { className: css.search },
          h(SearchIcon, null),
          h('input', {
            type: 'search',
            value: query,
            disabled: props.remote === undefined,
            placeholder: '搜索记忆与文档（按回车检索）',
            'aria-label': '搜索记忆与文档',
            autoFocus: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) },
            onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                run()
              }
            },
          }),
        ),
        props.remote === undefined ? null : h('div', { className: css.toolbar },
          h('label', { className: css.field }, '类型',
            h('select', {
              className: css.input,
              value: kind,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setKind(e.target.value) },
            },
            h('option', { value: 'all' }, '全部'),
            h('option', { value: 'fact' }, '仅记忆'),
            h('option', { value: 'doc_chunk' }, '仅文档'),
            )),
          h('label', { className: css.field }, '门槛',
            h('select', {
              className: css.input,
              value: floors,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setFloors(e.target.value) },
            },
            h('option', { value: 'strict' }, '严格'),
            h('option', { value: 'loose' }, '宽松'),
            )),
          h(DomainField, {
            label: '知识域（domain）',
            value: domain,
            onChange: setDomain,
            catalog: domainCatalog,
            emptyLabel: '全部',
            placeholder: '如 design',
          }),
          h(Field, { label: '来源（source）', value: source, onChange: setSource, placeholder: '如 spec' }),
          h(Btn, { label: '检索', disabled: queryLoading, onClick: run }),
        ),
        props.remote === undefined ? null : h('div', { className: css.status }, queryLoading ? '查询中…' : queryStatus),
        // An empty result had no explanation at all, which is half of the 「我是谁」 complaint: the
        // answer WAS the top-ranked candidate and a relevance floor removed it. The two readings of
        // an empty answer are told apart here — "the floors removed N, 宽松 is one switch away" vs
        // "nothing relevant at all (the relaxed profile is already in force)".
        props.remote !== undefined && !queryLoading && error === undefined && hits.length === 0 && queryStatus.startsWith('命中') && floors === 'strict' && floorDropped > 0
          ? h('div', { className: css.status }, `没有达到相关性门槛的结果（严格门槛丢弃了 ${String(floorDropped)} 条）——可切「宽松」重试。`)
          : null,
        props.remote !== undefined && !queryLoading && error === undefined && hits.length === 0 && queryStatus.startsWith('命中') && floors === 'loose' && floorDropped > 0
          ? h('div', { className: css.status }, `确实没有相关结果（宽松门槛下仍丢弃了 ${String(floorDropped)} 条）。`)
          : null,
        props.remote !== undefined && !queryLoading && error === undefined && hits.length === 0 && queryStatus.startsWith('命中') && floorDropped === 0
          ? h('div', { className: css.status }, '没有匹配项。知识库为空时先用「入库/导入」添加文档；记忆里也只包含已写入的事实。')
          : null,
        groups.map(([groupName, groupHits]) => h(
          'div',
          { key: groupName },
          h('div', { className: css.groupHead }, groupName),
          h('ul', { className: css.list }, groupHits.map(hit => h(
            'li',
            { key: `${hit.source_ref}:${String(hit.ref_id)}`, className: css.item },
            hit.text,
            h('span', { className: css.meta },
              `${hit.kind} · score ${hit.score.toFixed(3)} · ${hit.source_ref}`
              + (hit.entities && hit.entities.length > 0 ? ` · 实体：${hit.entities.join('、')}` : '')
              // 记忆的「何时记下 / 何时改过」：updated_at 只在行被改动时前进，检索不会写它，
              // 所以它与 created_at 不同才是真的改过（而不是刚被查到过）。
              + ` · 创建于 ${hit.created_at}`
              + (hit.updated_at !== null && hit.updated_at !== hit.created_at ? ` · 更新于 ${hit.updated_at}` : '')),
          ))),
        )),
      )
      : null,

    // ─── KB 管理：按钮都在上面的 sticky 头部里 ───
    showIngest
      ? h('div', { className: `${css.item} ${css.form}` },
        h('div', { className: css.toolbar },
          h(DomainField, {
            label: '知识域（domain）',
            value: iDomain,
            onChange: setIDomain,
            catalog: domainCatalog,
            emptyLabel: '请选择知识域',
            placeholder: '如 design',
            onAdd: addDomain,
          }),
          h(Field, { label: '来源（source）', value: iSource, onChange: setISource, placeholder: '缺省 default' }),
          h(Field, { label: '标题（title，可选）', value: iTitle, onChange: setITitle, placeholder: '缺省取正文首个标题或首行' }),
        ),
        // 来源 / 粘贴文本 are ALTERNATIVES — one 入库 button with one classification, not two calls —
        // so the form shows exactly one of them. The hidden one keeps its value and says so on the
        // toggle, and `canIngest` only ever reads the visible one. Their meanings differ: a
        // URL/file/directory keeps replace-by-identity, while 粘贴文本 (and anything the host
        // classifies as plain text) only ADDS — the same identity is refused.
        h('div', { className: css.toolbar },
          h('button', {
            type: 'button',
            className: inputMode === 'source' ? `${css.btn} ${css.btnActive}` : css.btn,
            onClick: () => { setInputMode('source') },
          }, sourceText !== '' && inputMode !== 'source' ? '来源 ·有内容' : '来源'),
          h('button', {
            type: 'button',
            className: inputMode === 'text' ? `${css.btn} ${css.btnActive}` : css.btn,
            onClick: () => { setInputMode('text') },
          }, bodyText !== '' && inputMode !== 'text' ? '粘贴文本 ·有内容' : '粘贴文本'),
        ),
        inputMode === 'source'
          ? h('div', { className: css.toolbar },
            h(Field, {
              label: '来源（http(s) URL / 本地文件 / 本地目录，多条路径用空格或逗号分隔）',
              value: iUri,
              onChange: setIUri,
              placeholder: '如 https://… 或 ~/docs/spec.md 或 ~/docs',
            }),
            h(Btn, { label: '选择', disabled: loading, onClick: () => { browseTo() } }),
          )
          : h('label', { className: css.field }, '粘贴文本',
            h('textarea', {
              className: css.textarea,
              value: iText,
              rows: 4,
              placeholder: '直接粘贴要入库的内容',
              onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setIText(e.target.value) },
            })),
        h('div', { className: css.row },
          h(Btn, { label: '入库', disabled: loading || !canIngest, onClick: submitIngest }),
          h('div', { className: ingestBlocked ? `${css.status} ${css.hintWarn}` : css.status }, ingestHint),
        ),
        // ─── 选择器：宿主按摄入边界列举，浏览器里点选 ───
        picker === null
          ? null
          : h('div', { className: css.picker },
            h('div', { className: css.pickerHead },
              h('code', { className: css.pickerPath }, picker.listing?.path ?? '读取中…'),
              h('div', { className: css.status },
                picker.listing === null
                  ? ''
                  : picker.listing.unrestricted
                    ? '不限制范围（knowledge.ingest.allow_outside_workspace = true），可浏览整个文件系统'
                    : `可浏览范围：${picker.listing.roots.join('、')}`)),
            picker.error === undefined ? null : h('div', { className: css.error }, picker.error),
            picker.listing === null
              ? null
              : h('ul', { className: css.pickerList },
                picker.listing.parent === null
                  ? null
                  : h('li', { key: '..' }, h('button', {
                    type: 'button',
                    className: css.pickerEntry,
                    onClick: () => { browseTo(picker.listing?.parent ?? undefined) },
                  }, '../（上级目录）')),
                picker.listing.entries.map(entry => h('li', { key: entry.path }, h('button', {
                  type: 'button',
                  className: entry.kind === 'other' ? `${css.pickerEntry} ${css.pickerDisabled}` : css.pickerEntry,
                  disabled: entry.kind === 'other',
                  onClick: () => { if (entry.kind === 'dir') browseTo(entry.path); else choosePath(entry.path) },
                }, entry.kind === 'dir' ? `${entry.name}/` : entry.kind === 'ingestable' ? entry.name : `${entry.name}（不可摄入）`)))),
            h('div', { className: css.row },
              picker.listing === null
                ? null
                : h(Btn, { label: '选择此目录', disabled: loading, onClick: () => { choosePath(picker.listing?.path ?? '') } }),
              h(Btn, { label: '取消', disabled: loading, onClick: () => { setPicker(null) } })),
          ),
      )
      : null,
    // ─── 页面主体：文档列表（打开「知识」标签页即见；滚到底自动取下一页） ───
    docs === null
      // `docs === null` means "never loaded", which a failure also leaves it at — so the failed
      // state has to say so and offer the retry, or the tab sits on 读取中… forever (the refresh
      // button that used to be here was removed when the list became the page body).
      ? h('div', { className: css.status },
        error === undefined ? '读取文档列表…' : '文档列表读取失败。',
        error === undefined
          ? null
          : h(Btn, { label: '重试', disabled: loading, onClick: () => { refresh() } }))
      : docs.length === 0
        ? h('div', { className: css.status }, '知识库暂无文档。可用「入库/导入」添加。')
        : h('ul', { className: css.list }, docs.map(doc => h(
          'li',
          { key: doc.doc_id, className: css.item },
          `${doc.title}（${doc.domain} → ${doc.source}）`,
          staleIds.has(doc.doc_id)
            ? h('span', { className: css.warn }, '文件已修改 · 待重新摄入')
            : null,
          missingIds.has(doc.doc_id)
            ? h('span', { className: css.warn }, unclaimedIds.has(doc.doc_id)
              ? '文件无 frontmatter · 可认领'
              : '受管文件缺失')
            : null,
          h('span', { className: css.meta },
            `#${String(doc.doc_id)}${doc.source_uri ? ` · ${doc.source_uri}` : ''}${doc.updated_at ? ` · 更新于 ${doc.updated_at}` : ''}`),
          h('div', { className: css.row },
            h(Btn, { key: 'detail', label: docDetail?.id === doc.doc_id ? '收起切片' : '查看切片', disabled: loading, onClick: () => { showDocumentDetail(doc.doc_id) } }),
            // 编辑 / 打开目录 act on the MANAGED COPY (`knowledge.docs.dir`), never on whatever
            // `source_uri` points at: the copy is what this KB owns, and deleting or editing a
            // document must not reach into the user's working tree.
            h(Btn, {
              key: 'edit',
              label: '编辑',
              disabled: loading || missingIds.has(doc.doc_id),
              onClick: () => { openDoc(doc.doc_id, 'file') },
            }),
            h(Btn, {
              key: 'dir',
              label: '打开目录',
              disabled: loading || missingIds.has(doc.doc_id),
              onClick: () => { openDoc(doc.doc_id, 'dir') },
            }),
            staleIds.has(doc.doc_id)
              ? h(Btn, { key: 'resync', label: '重新摄入', disabled: loading, onClick: () => { syncDocs(doc.doc_id) } })
              : null,
            // Only offered for a file the store has ALREADY identified as adoptable (no frontmatter,
            // path names this document, nobody else claims it) — never as a way to force anything.
            unclaimedIds.has(doc.doc_id)
              ? h(Btn, { key: 'adopt', label: '认领文件', disabled: loading, onClick: () => { syncDocs(doc.doc_id, true) } })
              : null,
            h(Btn, {
              key: 'remove',
              label: '删除',
              danger: true,
              disabled: loading,
              onClick: () => { confirmRemoveDoc(doc) },
            }),
          ),
          docDetail?.id === doc.doc_id
            ? h('div', { className: css.meta },
              `共 ${String(docDetail.data.chunks?.length ?? 0)} 个切片`,
              (docDetail.data.chunks ?? []).slice(0, 20).map(chunk => h(
                'div',
                { key: chunk.chunk_id, className: css.chunkBox },
                h('span', { className: css.badge }, `#${String(chunk.idx)}${chunk.headings_path ? ` · ${chunk.headings_path}` : ''}`),
                h('div', null, chunk.text.length > 200 ? `${chunk.text.slice(0, 200)}…` : chunk.text),
              )),
              (docDetail.data.chunks?.length ?? 0) > 20 ? h('div', null, `……其余 ${String((docDetail.data.chunks?.length ?? 0) - 20)} 个切片省略`) : null)
            : null,
        ))),
    docsTruncated
      ? h('button', {
        type: 'button',
        className: css.more,
        disabled: loading,
        onClick: () => { loadDocs(docsOffset) },
      }, loading ? '加载中…' : '加载更多')
      : null,
  )
}

/** Client cordis-plugin name shown in boot diagnostics. */
export const name = 'avantf-mem-client'

/**
 * Services required to render the two tabs. `remote` (not `remote.avantfMem`)
 * on purpose: a missing namespace must not leave this entry pending, because
 * the client boot rejects the whole tree when any entry is pending.
 */
export const inject = ['slots', 'remote']

/** Contribute the two `conversation.view` tabs, mounting this package's Remote namespace first. */
export async function apply(ctx: ClientContext): Promise<void> {
  let remote: AvantfRemote | undefined
  try {
    // The Client only auto-mounts the harness's generated namespace list, so an
    // out-of-tree plugin mounts its own contribution before using it.
    await ctx.remote.$mount(clientContribution)
    // Resolved through `get()`: reading `ctx.remote.avantfMem` directly is
    // refused unless `remote.avantfMem` is in this plugin's own inject list.
    remote = ctx.get('remote.avantfMem') as AvantfRemote | undefined
    if (remote === undefined) {
      console.error('[avantf-mem] client apply: contribution mounted but no remote.avantfMem service')
    } else {
      console.log('[avantf-mem] client apply: avantfMem remote mounted')
    }
  } catch (error) {
    console.error('[avantf-mem] client apply: mounting the avantfMem contribution failed', error)
  }

  // Two `conversation.view` tabs, ordered after 对话 (0) and 轨迹 (10) — the same
  // strip. The mount is unchanged: the seat hands session-scoped props we ignore,
  // and the panels read everything through the `avantfMem` Remote.
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'memory', order: 20, label: () => '记忆' },
    () => React.createElement(MemoryPanel, { remote }),
  ))
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'knowledge', order: 30, label: () => '知识' },
    () => React.createElement(KnowledgePanel, { remote }),
  ))

  // The panels live ONLY here, in the main window's view strip; the settings page intentionally
  // carries no 记忆/知识 entries (the panels used to be registered into `settings.section` too, as an
  // always-reachable route while a blank session hides the strip — the product decision is that the
  // tabs are the single home, so that duplication is gone and `ui-settings` is no longer a client
  // dependency).
  console.log('[avantf-mem] client apply: tabs registered (记忆, 知识) in the conversation view strip')
}
