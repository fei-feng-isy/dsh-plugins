/**
 * Typed CSS modules for the client tabs.
 *
 * The class list is spelled out instead of `Record<string, string>` on purpose: with an index
 * signature, `css.typo` type-checks and resolves to `undefined` at runtime, so the element simply
 * loses its styling and nothing reports it. That is how `css.detail` shipped against a stylesheet
 * that had no `.detail` rule.
 *
 * Keep this in sync with `client/pages.module.css`: the test suite checks this list against the
 * stylesheet, because a class that drifts on either side is otherwise a silent styling loss.
 */
declare module '*.module.css' {
  const classes: {
    readonly badge: string
    readonly btn: string
    readonly btnActive: string
    readonly btnDanger: string
    readonly chunkBox: string
    readonly detail: string
    readonly error: string
    readonly field: string
    readonly fieldHead: string
    readonly form: string
    readonly groupHead: string
    readonly headbar: string
    readonly hintWarn: string
    readonly input: string
    readonly item: string
    readonly list: string
    readonly meta: string
    readonly more: string
    readonly picker: string
    readonly pickerDisabled: string
    readonly pickerEntry: string
    readonly pickerHead: string
    readonly pickerList: string
    readonly pickerPath: string
    readonly row: string
    readonly search: string
    readonly section: string
    readonly status: string
    readonly textarea: string
    readonly toolbar: string
    readonly warn: string
  }
  export default classes
}

declare module '*.css'
