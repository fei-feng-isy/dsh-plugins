/**
 * The view's stylesheet, injected once under a single `data-plugin` tag; the hand-rolled
 * bundle has no CSS pipeline, so it ships as a template string.
 * @module @avantf/dsh-work/client/styles
 */
const STYLE_ID = 'avantf-dsh-work-styles'

const CSS = `
.avwf-root { display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: hidden; padding: 8px 0 16px; font-size: 12px; width: 100%; max-width: var(--dsh-chat-content-width); margin: 0 auto; }
/* Line the panel up with the conversation's content column instead of running flush to the
   viewport edges — the same rule @avantf/mem-dsh uses on the same shared property
   (--dsh-chat-content-width, published by ui-conversation's root and what ui-chat's message
   column centers itself on), so the 记忆 tab and this one sit on one axis and one width. The
   property is inherited; where it is absent the declaration is invalid at computed-value time
   and max-width falls back to none, i.e. full bleed as before. No horizontal padding on the
   root: the tree boxes ARE the items, and their edges must land where the 记忆 items' do. */
.avwf-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
/* The windowed list: a canvas of the full scroll height, with only the trees inside
   the window mounted and placed by the virtualizer. */
.avwf-canvas { position: relative; width: 100%; }
.avwf-slot { position: absolute; top: 0; left: 0; width: 100%; padding-bottom: 8px; }
/* Text colours come from the label tokens, never from opacity.
   Opacity is the trap: it MULTIPLIES down a subtree, so one dimmed ancestor plus one dimmed
   child lands near 2.5:1 in either theme — unreadable at 12px. Measured on the item fill
   (bg-layer-1 = #fff light / #232324 dark): label-primary 18.9:1 and 15.0:1,
   label-secondary 5.8:1 and 10.4:1. Both clear 4.5:1 on both themes; label-tertiary
   (3.7:1 light) is only used for affordances, not for anything that must be read. */
.avwf-empty, .avwf-error { color: var(--dsw-alias-label-secondary); padding: 8px 2px; line-height: 1.6; }
.avwf-error { color: var(--dsw-alias-state-error-primary, #d9534f); }
/* Item colours come from the same design tokens @avantf/mem-dsh uses for its 记忆 items, so
   the two tabs read as one surface: fill from bg-layer-1, text from label-primary. Both tokens
   are defined by the shell for light and dark; an absent token makes the declaration invalid at
   computed-value time, i.e. it degrades to transparent/inherited rather than to a wrong colour. */
.avwf-tree { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px; padding: 4px 0 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.avwf-tree-settled { border-style: dashed; }
.avwf-tree-header { display: flex; align-items: center; gap: 8px; padding: 2px 8px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); margin-bottom: 4px; }
.avwf-root-id { font-family: ui-monospace, monospace; color: var(--dsw-alias-label-secondary); }
.avwf-tree-summary { color: var(--dsw-alias-label-secondary); }
.avwf-spacer { flex: 1 1 auto; }
.avwf-node { display: flex; flex-direction: column; }
.avwf-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px 1px 0; line-height: 1.7; border-radius: 3px; }
.avwf-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.avwf-twisty { width: 16px; flex: 0 0 16px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; padding: 0; }
.avwf-twisty-empty { cursor: default; color: var(--dsw-alias-label-dimmed, currentColor); }
.avwf-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--avwf-status, currentColor); }
.avwf-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; font: inherit; text-align: left; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
.avwf-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avwf-title:hover .avwf-title-text { text-decoration: underline; text-underline-offset: 2px; }
.avwf-title-open .avwf-title-text { font-weight: 600; }
.avwf-detail-hint { color: var(--dsw-alias-label-secondary); }
.avwf-reused { color: var(--dsw-alias-label-secondary); border: 0.5px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 3px; padding: 0 3px; }
.avwf-row:hover .avwf-detail-hint { color: var(--dsw-alias-label-primary); }
/* The badge is text: it wears a label colour and takes its status hue from the tint only.
   A status colour as TEXT does not survive both themes (light-theme green is 2.3:1). */
.avwf-badge { flex: 0 0 auto; padding: 0 6px; border-radius: 9px; font-size: 11px; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--avwf-status, currentColor) 18%, transparent); }
.avwf-meta { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.avwf-context { color: var(--dsw-alias-label-secondary); padding-top: 1px; padding-bottom: 3px; line-height: 1.5; }
/* A status is a HUE, published as a custom property and consumed by shapes (the dot) and as a
   background tint (the badge). The state tokens are the platform's own — the --dsh-color-*
   names this file used before do not exist in the design platform, so each of them was
   silently falling back to the hardcoded hex. */
.avwf-ready { --avwf-status: var(--dsw-alias-state-business-primary, #4a9eda); }
.avwf-running { --avwf-status: var(--dsw-alias-state-warn-label, #d9a441); }
.avwf-interrupted { --avwf-status: var(--dsw-alias-state-warn-label, #d9a441); }
.avwf-blocked { --avwf-status: var(--dsw-alias-label-tertiary, #8a8f96); }
.avwf-done { --avwf-status: var(--dsw-alias-state-success-primary, #4c9a5a); }
.avwf-failed { --avwf-status: var(--dsw-alias-state-error-primary, #d9534f); }
.avwf-delete { flex: 0 0 auto; font: inherit; font-size: 11px; padding: 0 6px; border: 1px solid color-mix(in srgb, currentColor 45%, transparent); border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.avwf-delete:hover { color: var(--dsw-alias-label-primary); }
/* A disabled control is allowed to read as inert; an enabled one is not. */
.avwf-delete:disabled { opacity: .4; cursor: default; }
.avwf-delete-armed { color: var(--dsw-alias-state-error-primary, #d9534f); border-color: currentColor; }
.avwf-detail { margin: 2px 0 6px; padding: 6px 8px; border-left: 2px solid color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 4%, transparent); border-radius: 0 4px 4px 0; display: flex; flex-direction: column; gap: 3px; }
.avwf-detail-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.avwf-detail-id { font-family: ui-monospace, monospace; color: var(--dsw-alias-label-secondary); }
.avwf-detail-label { margin-top: 3px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.avwf-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.avwf-detail-title { font-weight: 600; }
.avwf-detail-none { color: var(--dsw-alias-label-secondary); }
.avwf-detail-pointer { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, monospace; }
.avwf-detail-failed { color: var(--dsw-alias-state-error-primary, #d9534f); }
.avwf-detail-context { margin: 0; padding-left: 16px; line-height: 1.6; }
.avwf-detail-child { margin-top: 3px; padding: 3px 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 4%, transparent); }
.avwf-detail-child-head { display: flex; align-items: center; gap: 6px; }
.avwf-detail-child-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avwf-detail-foot { margin-top: 4px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--dsw-alias-label-secondary); }
`

/**
 * Inject once per document: the view remounts on every session switch, and a second
 * `<style>` per mount would grow the document without limit.
 */
export function INSTALL_STYLES(): void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.setAttribute('data-plugin', '@avantf/dsh-work')
  style.textContent = CSS
  document.head.appendChild(style)
}
