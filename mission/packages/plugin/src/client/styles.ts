/**
 * The view's stylesheet, injected once under a single `data-plugin` tag; the hand-rolled
 * bundle has no CSS pipeline, so it ships as a template string.
 * @module @avantf/dsh-mission/client/styles
 */
const STYLE_ID = 'avantf-dsh-mission-styles'

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
.avwf-empty, .avwf-error, .avwf-warn { color: var(--dsw-alias-label-secondary); padding: 8px 2px; line-height: 1.6; }
.avwf-error { color: var(--dsw-alias-state-error-primary, #d9534f); }
/* A version-skew note, not a failure: the trees below it are still rendered, so it must not read as
   the error colour. Same token family as the error, one step softer, with a readable fallback. */
.avwf-warn { color: var(--dsw-alias-state-warning-primary, #b8860b); }
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
/* Same treatment as the reused tag: a bordered label, because both say "read this row differently"
   rather than naming a state. Deliberately NOT a status hue — a correction is an event, not a status. */
.avwf-corrected { border: 0.5px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 3px; padding: 0 3px; }
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
.avwf-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.avwf-detail-none { color: var(--dsw-alias-label-secondary); }
.avwf-detail-pointer { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, monospace; }
.avwf-detail-failed { color: var(--dsw-alias-state-error-primary, #d9534f); }
/* The corrections are the reader's own instructions, not background: full-strength text, where the
   context list above stays secondary. */
.avwf-detail-corrections { color: var(--dsw-alias-label-primary); }
/* One entry of a list section — context / analysis / corrections — and the identical box a child's
   result wears, because these are all multi-line prose and the box, not a bullet glyph, is what
   separates them. Shared on purpose: the four sections have to read as ONE list style. */
.avwf-detail-item { padding: 5px 9px; border-radius: 5px; background: color-mix(in srgb, currentColor 5%, transparent); }
.avwf-detail-child { display: flex; flex-direction: column; gap: 2px; }
/* The expanded full result wears the same box as every other long entry, so it reads as one block
   instead of as prose that starts again after the locator. */
.avwf-detail-full { padding: 6px 10px; border-radius: 5px; background: color-mix(in srgb, currentColor 4%, transparent); }
/* A link-styled button: the panel's one "do this now" affordance. It wears the shell's LINK token,
   not a status hue — a status colour as text does not survive both themes (see the badge note). */
.avwf-link { align-self: flex-start; padding: 0; border: 0; background: transparent; font: inherit; color: var(--dsw-alias-link, var(--dsw-alias-label-primary)); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.avwf-link:hover { text-decoration-thickness: 2px; }
.avwf-link:disabled { color: var(--dsw-alias-label-secondary); cursor: default; text-decoration: none; }
.avwf-detail-child-head { display: flex; align-items: center; gap: 6px; }
.avwf-detail-child-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The detail dialog, built to the shell's 设置 panel: full-viewport mask + a centered card split
   into a section rail and a scrolling content column. Layout numbers follow that panel where the
   content is the same shape; the card is 1040x880, wider than the settings panel because the
   reading matter here is a column of prose plus long lists, and the settings' 800px left the
   content column cramped once the 176px rail took its share. */
.avwf-dialog-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
.avwf-dialog-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
.avwf-dialog-panel { position: relative; z-index: 1; display: flex; width: 1040px; height: min(880px, calc(100vh - 2 * max(24px, var(--dsh-frame-top-clearance, 24px)))); max-width: calc(100vw - 48px); border-radius: 24px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.avwf-dialog-nav { flex: none; display: flex; flex-direction: column; gap: 18px; width: 176px; padding: 22px 12px 0; box-sizing: border-box; }
.avwf-dialog-nav-title { padding: 0 12px; font-size: 17px; line-height: 26px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.avwf-dialog-nav-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.avwf-dialog-nav-cell { display: flex; align-items: center; gap: 8px; height: 42px; padding: 9px 12px; box-sizing: border-box; border: none; border-radius: 12px; background: transparent; cursor: pointer; font-family: inherit; font-size: 15px; line-height: 24px; color: var(--dsw-alias-label-primary); text-align: left; }
.avwf-dialog-nav-cell:hover { background: var(--dsw-specific-sidebar-nav-item-hover, color-mix(in srgb, currentColor 6%, transparent)); }
.avwf-dialog-nav-cell-active { background: var(--dsw-specific-sidebar-nav-item-active, color-mix(in srgb, currentColor 9%, transparent)); }
.avwf-dialog-nav-label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.avwf-dialog-nav-count { flex: none; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.avwf-dialog-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.avwf-dialog-header { flex: none; display: flex; align-items: flex-start; gap: 12px; padding: 20px 16px 10px 14px; box-sizing: border-box; }
.avwf-dialog-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* The mission's title IS the dialog heading. It wraps rather than elides: a title is the one piece of
   text a reader must not have to hover to read, and titles run to 80 characters by construction. */
.avwf-dialog-head-title { margin: 0; font-size: 17px; line-height: 1.45; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.avwf-dialog-head-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.avwf-dialog-head-id { font-family: ui-monospace, monospace; }
.avwf-dialog-head-meta .avwf-badge { font-size: 12px; }
.avwf-dialog-close { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: none; border-radius: 30px; background: transparent; cursor: pointer; font: inherit; font-size: 16px; color: var(--dsw-alias-label-primary); }
.avwf-dialog-close:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 6%, transparent)); }
/* The body is the only scrolling region: the rail is short and the header is fixed, so a long
   description or a long child list scrolls inside a panel that stays put — the point of the dialog.
   15px/1.7, one step above the row text: this is the surface meant for actual reading, and 14px at
   this width read as fine print. The section hints and the meta lines scale with it. */
.avwf-dialog-body { flex: 1; min-height: 0; padding: 0 28px 28px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; font-size: 15px; line-height: 1.7; }
.avwf-dialog-body .avwf-meta { font-size: 13px; }
.avwf-dialog-hint { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
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
  style.setAttribute('data-plugin', '@avantf/dsh-mission')
  style.textContent = CSS
  document.head.appendChild(style)
}
