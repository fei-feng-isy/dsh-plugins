/**
 * `@avantf/dsh-identity` — the browser half: ONE settings-panel page.
 *
 * `settings.section` is the settings panel's own extension point (declared by
 * `dsh-client-ui-settings-general`'s `SettingsRoot`): registering one entry yields "a nav item on the
 * left, a pane on the right". The id must be NEW — reusing `general`/`models`/`plugins`/`agent-presets`
 * would render into another plugin's slot — so this page owns `identity` at order 25, after `account`.
 *
 * `inject` is `['remote', 'slots', 'locale']` and NOTHING dotted: `remote.avantfIdentity` only exists
 * after this half mounts its own contribution, so a dotted entry would leave this client plugin
 * pending forever and the startup audit throws (the accident the sibling trees recorded).
 *
 * @module @avantf/dsh-identity/client
 */
import { createElement as h, type ReactNode } from 'react'
import { clientContribution } from '../wire.js'
import { IdentitySection } from './IdentitySection.js'
import { resolveConfigForm, wrapRemote, type ConfigFormLike, type IdentityRemote } from './api.js'

/** Cordis plugin name; matches the host half and the profile row. */
export const name = 'avantf-identity'

/** Required client services; the Remote namespace itself is intentionally absent (see above). */
export const inject = ['remote', 'slots', 'locale']

/**
 * The profile row id. It is ALSO the settings namespace the plugin's Config form lives under, so the page
 * resolves its form with this exact string — not with the whole `configForms` service.
 */
const ROW_ID = 'avantf-identity'

/** The i18n namespace, and the slot's `locale` value. */
const NS = 'settings.identity'

const LOG_PREFIX = '[avantf-identity]'

const zh = {
  nav: '身份',
  title: '身份',
  switch: '启用身份',
  fileIdentity: '身份（IDENTITY.md）',
  fileSoul: '灵魂（SOUL.md）',
  fileRules: '规则（RULES.md）',
  save: '保存',
  saved: '已保存，新会话生效',
  empty: '（空）',
  del: '删除',
  saveAs: '存为新预设',
  newPresetId: '新预设 id（小写字母、数字与连字符）',
  ok: '确定',
  cancel: '取消',
  unavailable: '身份 Remote 尚未挂载：请重启 dsh 后再试。',
  noConfigForm: '设置表单尚未就绪，开关暂不可用。',
  confirmApply: '是否启用 {id}？确定后新会话生效。',
  confirmDelete: '删除这个预设？',
  missingFields: '状态字段缺失',
  received: '实收字段',
}

const en = {
  nav: 'Identity',
  title: 'Identity',
  switch: 'Use the identity',
  fileIdentity: 'Identity (IDENTITY.md)',
  fileSoul: 'Soul (SOUL.md)',
  fileRules: 'Rules (RULES.md)',
  save: 'Save',
  saved: 'Saved; it takes effect in a new session',
  empty: '(empty)',
  del: 'Delete',
  saveAs: 'Save as preset',
  newPresetId: 'New preset id (lower-case letters, digits, hyphens)',
  ok: 'OK',
  cancel: 'Cancel',
  unavailable: 'The identity Remote is not mounted yet; restart dsh and try again.',
  noConfigForm: 'The settings form is not ready yet, so the switch is unavailable.',
  confirmApply: 'Enable {id}? It takes effect in a new session.',
  confirmDelete: 'Delete this preset?',
  missingFields: 'status fields missing',
  received: 'received',
}

/** The slice of the client Context this half uses, declared structurally (see `api.ts`). */
interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  logger: { error(message: string): void }
  locale: {
    register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
    /**
     * The locale face's own reader. The service IS the face (`bind` + `getSnapshot`/`subscribe`), so this
     * is the method name: `snapshot()` does not exist, and reading it silently resolved every preset to
     * English while dsh was showing Chinese (the service never threw, it simply had no such member).
     */
    getSnapshot(): { readonly active?: string }
  }
  remote: { $mount(contribution: unknown): Promise<unknown> }
  get(name: string): unknown
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(
      options: { name: string; id: string; order: number; locale: string; label: () => string },
      component: (props: { close: () => void }) => ReactNode,
    ): () => void
  }
}

export function apply(ctx: ClientContext): void {
  const log = (level: 'log' | 'error', message: string): void => {
    console[level](`${LOG_PREFIX} ${message}`)
    try {
      if (level === 'error') ctx.logger.error(`${LOG_PREFIX} ${message}`)
    } catch {
      // A logging failure must not break the mount it is describing.
    }
  }
  log('log', 'client half mounting: settings.section page + avantfIdentity Remote namespace')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'avantf-identity: dictionaries')

  /**
   * The Remote namespace, mounted asynchronously. The page is registered regardless — a failed mount
   * must show "the Remote is not mounted", never a missing nav item, and must never fail the web boot.
   */
  const state: { remote?: IdentityRemote } = {}
  const mounted = ((): { promise: Promise<void>; settle: () => void } => {
    let settle = (): void => {}
    const promise = new Promise<void>((resolve) => { settle = resolve })
    return { promise, settle }
  })()
  void ctx.remote
    .$mount(clientContribution as never)
    .then(() => {
      // The namespace answers an ENVELOPE per call; the page wants payloads (see `wrapRemote`).
      state.remote = wrapRemote(ctx.get(`remote.${'avantfIdentity'}`) as IdentityRemote | undefined)
      log(state.remote === undefined ? 'error' : 'log',
        state.remote === undefined
          ? 'contribution mounted but ctx.get("remote.avantfIdentity") is undefined; the page will report it'
          : 'Remote namespace mounted: the identity page can read and write the files')
      mounted.settle()
    })
    .catch((cause: unknown) => {
      log('error', `mounting the Remote contribution failed: ${String(cause)}`)
      mounted.settle()
    })

  const t = ctx.locale.bind(NS)
  /** The language dsh is showing right now: what every preset read/apply is resolved against. */
  const activeLocale = (): string => {
    try {
      const active = ctx.locale.getSnapshot().active
      return typeof active === 'string' && active !== '' ? active : 'en'
    } catch {
      return 'en'
    }
  }

  /**
   * Built ONCE and handed to the registry verbatim: the host keys the rendered entry by ENTRY IDENTITY,
   * so a fresh options object or a fresh component identity would read as "a different page".
   */
  const sectionOptions = {
    name: 'settings.section',
    id: 'identity',
    // After general(0) / models(10) / plugins(15) / agent-presets(20) / account.
    order: 25,
    locale: NS,
    label: () => t('nav'),
  }
  const component = (props: { close: () => void }): ReactNode =>
    h(IdentitySection, {
      close: props.close,
      t,
      getRemote: () => state.remote,
      whenMounted: () => mounted.promise,
      // The SERVICE is not a form: the form is `service.get(rowId)`. Handing the service straight to the
      // page made `next.subscribe` throw inside the effect, and React then blanked the whole pane.
      getConfigForm: (): ConfigFormLike | undefined => resolveConfigForm(ctx.get('configForms'), ROW_ID),
      locale: activeLocale,
    })

  ctx.slots.inject('settings.section', () => ctx.slots.register(sectionOptions, component))
  log('log', 'registered the settings.section page: id=identity order=25')
}
