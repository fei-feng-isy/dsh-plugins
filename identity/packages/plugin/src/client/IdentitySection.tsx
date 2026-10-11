/**
 * The identity page: the switch, the three editors, and the preset library.
 *
 * It is rendered inside `settings.section`, so the ONLY prop the slot hands it is `close`; everything
 * else is fetched through the callbacks `index.ts` built. Two rules shape the code:
 *
 *   - the SWITCH is the host's config form (`configForms.get('avantf-identity')`), so writing it lands
 *     in the profile patch and hot-reloads the row exactly like a native setting; the page does not
 *     keep a second copy of that value;
 *   - the FILES go through this plugin's own Remote, and every write says "takes effect next turn"
 *     rather than pretending to be live.
 *
 * Styles use design tokens with hardcoded fallbacks (`var(--dsw-alias-…, #hex)`), so a token that a
 * future theme renames degrades to a sane inherited colour instead of an invisible one.
 *
 * @module @avantf/dsh-identity/client/IdentitySection
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { ConfigFormLike, FileText, IdentityRemote, StatusView } from './api.js'

export interface IdentitySectionProps {
  readonly close: () => void
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly getRemote: () => IdentityRemote | undefined
  readonly whenMounted: () => Promise<void>
  readonly getConfigForm: () => ConfigFormLike | undefined
  readonly locale: () => string
}

const FILES = ['IDENTITY', 'SOUL', 'RULES'] as const
type FileName = (typeof FILES)[number]

/** The harness input's own tokens (`ui-primitives/Input.module.css`), shared by the field and the select. */
const INPUT_STYLE: CSSProperties = {
  boxSizing: 'border-box',
  height: '32px',
  padding: '0 8px',
  borderRadius: 'var(--dsw-radius-md, 6px)',
  border: '0.5px solid var(--dsw-alias-border-l4, #444)',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: '14px',
  lineHeight: '22px',
}

const S: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 20px', color: 'var(--dsw-alias-label-primary, inherit)' },
  title: { fontSize: '17px', fontWeight: 600, margin: 0 },
  card: {
    border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  // The select sits at the card's left padding and the delete button at its right padding, so both are the
  // same distance from the border.
  identityRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
  // The two dialogs are in-page (never `window.confirm`/`prompt`) and mirror the harness's own
  // `ui-primitives/Modal.module.css`: same mask pair, same card surface and elevation, so the dialog
  // reads as the same material as the settings panel — which is also `bg-layer-2` + `elevation-prominent`.
  // Only the layer is one step higher (1100) than the panel's own 1000.
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 1100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
    backdropFilter: 'var(--dsw-mask-blur, none)',
  },
  dialog: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    width: 'min(380px, 100%)',
    padding: '20px 24px 24px',
    borderRadius: 'var(--dsw-radius-panel, 12px)',
    background: 'var(--dsw-alias-bg-layer-2, #242424)',
    boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.45))',
  },
  dialogTitle: {
    margin: 0,
    fontSize: '16px',
    lineHeight: '24px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  dialogFooter: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' },
  label: { fontSize: '12px', fontWeight: 600 },
  hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', lineHeight: 1.6 },
  textarea: {
    width: '100%',
    minHeight: '120px',
    resize: 'vertical',
    boxSizing: 'border-box',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    fontSize: '12px',
    lineHeight: 1.6,
    padding: '8px',
    borderRadius: 'var(--dsw-radius-md, 6px)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    border: '0.5px solid var(--dsw-alias-border-l4, #444)',
  },
  // The harness input's own tokens (`ui-primitives/Input.module.css`), so a field in here looks like a
  // field anywhere else.
  input: INPUT_STYLE,
  // The identity select takes every pixel the card can spare, so a long preset id is readable instead of
  // being clipped to the control's own width (`minWidth: 0` keeps the flex item from overflowing the card).
  identitySelect: { ...INPUT_STYLE, flex: '1 1 auto', minWidth: 0 },
  // `outline` / `primary` are the harness button variants (`ui-primitives/Button.module.css`). The earlier
  // hand-rolled pair used `brand-primary` + `#fff`, which resolved to a near-white step in the dark theme
  // and made the Save button invisible.
  button: {
    padding: '5px 12px',
    borderRadius: 'var(--dsw-radius-md, 6px)',
    fontSize: '13px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'transparent',
    border: '0.5px solid var(--dsw-alias-border-l3, #3a3a3a)',
  },
  primary: {
    padding: '5px 12px',
    borderRadius: 'var(--dsw-radius-md, 6px)',
    fontSize: '13px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    background: 'var(--dsw-alias-button-primary-fill, #2f6feb)',
    border: '0.5px solid transparent',
  },
  error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
  ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3aa76d)' },
}

const statusLabel: Record<FileName, string> = { IDENTITY: 'fileIdentity', SOUL: 'fileSoul', RULES: 'fileRules' }

/**
 * Fields the status card needs. A missing one is reported IN the page instead of blanking it.
 *
 * `satisfies` ties this list to `StatusView`, and `test/state.spec.ts` pins `StatusView` to the wire
 * schema's keys — so a field this page insists on cannot be one the wire never declares (which would
 * make every status read look "incomplete" instead of showing the real state).
 */
const REQUIRED_STATUS_FIELDS = ['profile', 'dataHome', 'fileCount', 'drop', 'files', 'presets'] as const satisfies readonly (keyof StatusView)[]

export function IdentitySection(props: IdentitySectionProps): ReactNode {
  const { t, getRemote, whenMounted, getConfigForm, locale } = props
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<FileName, string>>({ IDENTITY: '', SOUL: '', RULES: '' })
  const [baseline, setBaseline] = useState<Record<FileName, string>>({ IDENTITY: '', SOUL: '', RULES: '' })
  const [form, setForm] = useState<ConfigFormLike | undefined>(undefined)
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [newPresetId, setNewPresetId] = useState('')
  /**
   * The two in-page dialogs. They are ours, not `window.confirm`/`prompt`: the harness's own client code
   * never calls a browser dialog (grep over `packages/client/**` finds none), and `window.prompt` is not
   * implemented in an Electron renderer at all — a silent no-op on Desktop.
   */
  const [confirming, setConfirming] = useState<{ readonly kind: 'apply' | 'delete' | 'restore'; readonly id: string } | undefined>(undefined)
  const [naming, setNaming] = useState(false)

  const fail = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause))
    setNotice(undefined)
  }

  const refresh = useCallback(async (): Promise<void> => {
    const remote = getRemote()
    if (remote === undefined) return
    try {
      const [next, profile] = await Promise.all([
        remote.status({ locale: locale() }),
        remote.readProfile(),
      ])
      setStatus(next)
      setDrafts(toDrafts(profile.files))
      setBaseline(toDrafts(profile.files))
      setError(undefined)
    } catch (cause) {
      fail(cause)
    }
  }, [getRemote, locale])

  // The config form is resolved at USE time: `configForms` is provided by the settings domain, which may
  // activate after this page is registered.
  useEffect(() => {
    const next = getConfigForm()
    if (next === undefined) return undefined
    setForm(next)
    const read = (): void => {
      try {
        setEnabled(next.getSnapshot().value?.enabled === true)
      } catch {
        setEnabled(undefined)
      }
    }
    read()
    return next.subscribe(read)
  }, [getConfigForm])

  useEffect(() => {
    let live = true
    void whenMounted().then(() => {
      if (live) void refresh()
    })
    return () => { live = false }
  }, [whenMounted, refresh])

  /**
   * The envelope every action shares: busy while it runs, a refusal lands in the error line instead of
   * escaping the handler, and the page re-reads whatever the action changed. `run` only says WHAT to do,
   * and throws the host's reason when the host refuses.
   *
   * `act` adds the rule every REMOTE action needs (do nothing when the namespace never mounted); the
   * master switch goes through `run` directly, because the switch is the host's config form and a failed
   * typert mount must not turn the one control on the page into a dead checkbox.
   */
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setError(undefined)
      await refresh()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: (remote: IdentityRemote) => Promise<void>): Promise<void> => {
    const remote = getRemote()
    if (remote === undefined) return
    await run(() => action(remote))
  }

  const toggle = async (next: boolean): Promise<void> => {
    if (form === undefined) return
    await run(async () => {
      // The config form's own snapshot subscription keeps `enabled` current; mirroring the click here only
      // when the host accepted the write means a refusal cannot leave the switch showing an unstored value.
      if (await form.set('enabled', next)) setEnabled(next)
      if (next) {
        // Turning the identity ON for a profile that has no files yet: the first run releases the preset
        // LIBRARY only, so without this the switch would enable nothing and the three editors below would
        // stay empty. The host seeds `assistant` (never overwriting what is already there) and records it
        // as the active preset; a host too old to have the method simply skips it.
        const remote = getRemote()
        if (remote?.ensureProfile !== undefined) {
          const seeded = await remote.ensureProfile({ locale: locale() })
          if (!seeded.ok) throw new Error(seeded.error ?? 'seeding the identity failed')
        }
      }
    })
  }

  const save = async (): Promise<void> => {
    await act(async (remote) => {
      for (const name of FILES) {
        if (drafts[name] === baseline[name]) continue
        const result = await remote.writeProfileFile({ name, text: drafts[name] })
        if (!result.ok) throw new Error(result.error ?? `writing ${name}.md failed`)
      }
      setNotice(t('saved'))
    })
  }

  const applyPreset = async (id: string): Promise<void> => {
    // No notice on success: the dropdown shows which preset is now active, and the three editors show what
    // it wrote. A preset with no file in the requested language still applies (the host falls back to
    // `en`), and the English text in the editors is the signal for that. The identity being LEFT was filed
    // away by the host, so coming back here restores the user's own text rather than the preset's — that
    // is why the dropdown can be selected freely.
    await act(async (remote) => {
      const result = await remote.applyPreset({ id, locale: locale() })
      if (!result.ok) throw new Error(result.error ?? 'apply failed')
    })
  }

  /** Throw away this profile's own version of the active identity and take the preset's text back. */
  const resetToPreset = async (id: string): Promise<void> => {
    const remote = getRemote()
    if (remote === undefined) return
    // A host from before this action has no such method; say so instead of failing on a missing function.
    if (remote.resetToPreset === undefined) {
      setError(t('unavailable'))
      return
    }
    await act(async (host) => {
      const result = await host.resetToPreset({ id, locale: locale() })
      if (!result.ok) throw new Error(result.error ?? 'restore failed')
    })
  }

  const removePreset = async (id: string): Promise<void> => {
    await act(async (remote) => {
      const result = await remote.deletePreset({ id })
      if (!result.ok) throw new Error(result.error ?? 'delete failed')
    })
  }

  const saveAsPreset = async (): Promise<void> => {
    // No notice: the new id turns up in the dropdown, which is the visible result of saving as.
    await act(async (remote) => {
      const result = await remote.saveAsPreset({ id: newPresetId.trim(), locale: locale() })
      if (!result.ok) throw new Error(result.error ?? 'save-as failed')
      setNewPresetId('')
    })
  }

  const remoteMissing = getRemote() === undefined

  // The dropdown's options and its current value: the preset the host marks active, or `custom` when
  // the effective identity was written by hand rather than applied from the library.
  const presetList = status?.presets ?? []
  const activePresetId = presetList.find((item) => item.active)?.id ?? ''

  // What actually arrived, so a shape mismatch between the wire and this page is READABLE in the pane
  // rather than only in DevTools (the blank-pane report had nothing to go on).
  const receivedKeys = status === undefined ? [] : Object.keys(status as object)
  const missingStatus = status === undefined
    ? []
    : REQUIRED_STATUS_FIELDS.filter((field) => (status as unknown as Record<string, unknown>)[field] === undefined)

  return (
    <div style={S.root as CSSProperties}>
      {/* No refresh/close buttons: every action refreshes what it changed, and the settings shell owns
          the way out (its own close control). */}
      <h2 style={S.title as CSSProperties}>{t('title')}</h2>
      {remoteMissing ? <div style={S.error as CSSProperties}>{t('unavailable')}</div> : null}
      {error !== undefined ? <div style={S.error as CSSProperties}>{error}</div> : null}
      {notice !== undefined ? <div style={S.ok as CSSProperties}>{notice}</div> : null}
      {missingStatus.length > 0 ? (
        <div style={S.error as CSSProperties}>
          {t('missingFields')}: {missingStatus.join(', ')} · {t('received')}: {receivedKeys.join(', ') || t('empty')}
        </div>
      ) : null}

      <div style={S.card as CSSProperties}>
        <div style={S.row as CSSProperties}>
          <input
            type="checkbox"
            checked={enabled === true}
            disabled={form === undefined || busy}
            onChange={(event) => { void toggle(event.target.checked) }}
          />
          <span style={S.label as CSSProperties}>{t('switch')}</span>
          {form === undefined ? <span style={S.hint as CSSProperties}>{t('noConfigForm')}</span> : null}
        </div>
      </div>

      {/* Both cards are the identity surface: with the switch off there is nothing to choose or edit, so
          they are not rendered at all (the page is just the switch). */}
      {enabled === true ? (
        <>
          <div style={S.card as CSSProperties}>
            <div style={S.identityRow as CSSProperties}>
              {/* Selecting a preset IS applying it, after the confirmation below. The delete button sits at
                  the far edge, inset by the card's own padding — the same distance the select has on the
                  left. With every preset gone the select simply has no options and reads empty. */}
              <select
                style={S.identitySelect as CSSProperties}
                value={activePresetId}
                disabled={busy || remoteMissing}
                onChange={(event) => {
                  if (event.target.value !== '') setConfirming({ kind: 'apply', id: event.target.value })
                }}
              >
                {presetList.map((item) => (
                  <option key={item.id} value={item.id}>{item.id}</option>
                ))}
              </select>
              <button
                type="button"
                style={S.button as CSSProperties}
                disabled={busy || remoteMissing || activePresetId === ''}
                onClick={() => { setConfirming({ kind: 'delete', id: activePresetId }) }}
              >
                {t('del')}
              </button>
            </div>
            {/* Leaving an identity keeps what you wrote (the host files it under that id), so the only way
                back to the preset's own text is here — and it is offered exactly when it would change
                something. */}
            {status?.hasLocalEdit === true ? (
              <div style={S.row as CSSProperties}>
                <span style={S.hint as CSSProperties}>{t('modified')}</span>
                <button
                  type="button"
                  style={S.button as CSSProperties}
                  disabled={busy || remoteMissing || activePresetId === ''}
                  onClick={() => { setConfirming({ kind: 'restore', id: activePresetId }) }}
                >
                  {t('restore')}
                </button>
              </div>
            ) : null}
          </div>

          <div style={S.card as CSSProperties}>
            {FILES.map((name) => (
              <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: '4px' } as CSSProperties}>
                <span style={S.label as CSSProperties}>{t(statusLabel[name])}</span>
                <textarea
                  style={S.textarea as CSSProperties}
                  value={drafts[name]}
                  placeholder={t('empty')}
                  onChange={(event) => { setDrafts((current) => ({ ...current, [name]: event.target.value })) }}
                />
              </div>
            ))}
            <div style={S.row as CSSProperties}>
              <button type="button" style={S.primary as CSSProperties} disabled={busy || remoteMissing} onClick={() => { void save() }}>{t('save')}</button>
              <button
                type="button"
                style={S.button as CSSProperties}
                disabled={busy || remoteMissing}
                onClick={() => { setNewPresetId(''); setNaming(true) }}
              >
                {t('saveAs')}
              </button>
              <span style={S.hint as CSSProperties}>{t('saved')}</span>
            </div>
          </div>
        </>
      ) : null}

      {confirming !== undefined ? (
        <div style={S.overlay as CSSProperties} role="presentation">
          <div style={S.dialog as CSSProperties} role="dialog" aria-modal="true">
            <h3 style={S.dialogTitle as CSSProperties}>
              {t(confirming.kind === 'apply' ? 'confirmApply' : confirming.kind === 'restore' ? 'confirmReset' : 'confirmDelete', { id: confirming.id })}
            </h3>
            <div style={S.dialogFooter as CSSProperties}>
              <button type="button" style={S.button as CSSProperties} onClick={() => { setConfirming(undefined) }}>{t('cancel')}</button>
              <button
                type="button"
                style={S.primary as CSSProperties}
                disabled={busy}
                onClick={() => {
                  const action = confirming
                  setConfirming(undefined)
                  void (action.kind === 'apply' ? applyPreset(action.id) : action.kind === 'restore' ? resetToPreset(action.id) : removePreset(action.id))
                }}
              >
                {t('ok')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {naming ? (
        <div style={S.overlay as CSSProperties} role="presentation">
          <div style={S.dialog as CSSProperties} role="dialog" aria-modal="true">
            <h3 style={S.dialogTitle as CSSProperties}>{t('saveAs')}</h3>
            <input
              style={S.input as CSSProperties}
              value={newPresetId}
              placeholder={t('newPresetId')}
              onChange={(event) => { setNewPresetId(event.target.value) }}
            />
            <div style={S.dialogFooter as CSSProperties}>
              <button type="button" style={S.button as CSSProperties} onClick={() => { setNaming(false) }}>{t('cancel')}</button>
              <button
                type="button"
                style={S.primary as CSSProperties}
                disabled={busy || newPresetId.trim() === ''}
                onClick={() => { setNaming(false); void saveAsPreset() }}
              >
                {t('ok')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** `[{name,text}]` → the three-slot editor shape. */
function toDrafts(files: readonly FileText[]): Record<FileName, string> {
  const drafts: Record<FileName, string> = { IDENTITY: '', SOUL: '', RULES: '' }
  for (const file of files) {
    if (file.name === 'IDENTITY' || file.name === 'SOUL' || file.name === 'RULES') drafts[file.name] = file.text
  }
  return drafts
}
