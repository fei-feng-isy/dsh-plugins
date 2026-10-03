/**
 * The ONE rule that makes `lib/client.js` portable across build directories,
 * expressed as a check over the emitted text so both the bundler and the build
 * gate can enforce the same thing instead of keeping two copies of it.
 *
 * Why it is needed at all: two behaviors of the pinned client preset depend on
 * the ABSOLUTE stylesheet path, and they are the only two —
 *
 *   1. lightningcss's CSS Modules `pattern: '[hash]_[local]'` derives `[hash]`
 *      from the `filename` string handed to `transform()`, so the hashed class
 *      names (and therefore the emitted CSS text and the exported class map)
 *      move with the checkout;
 *   2. the CSS virtual module id is `\0dsh-css:<absolute path>.mjs`, and Rolldown
 *      prints a module id VERBATIM in its `//#region` marker.
 *
 * `packages/plugin/tsdown.config.ts` fixes both by handing the preset's CSS
 * plugins a virtual id whose embedded path is RELATIVE to the build cwd; this
 * module is what proves, on every build, that the fix is still in force. It is
 * deliberately general: it scans for the caller's roots, for any absolute CSS
 * virtual id, and for the class map the style injector itself emits — no file
 * name and no hash value is hardcoded.
 *
 * A third rule is not about portability but about the same artifact being the
 * PUBLISHED one: it may not end in a `//# sourceMappingURL=` reference. `files`
 * keeps `lib/client.js.map` out of the tarball (and `scripts/pack-plugin.mjs`
 * hard-fails if a map ever sneaks back in), so such a reference can only 404 in
 * a consumer's devtools. The client config therefore builds without a map, and
 * this rule makes a re-enabled `sourcemap` fail the build instead of silently
 * resurrecting the 404.
 */

/** Matches the `//#region` marker Rolldown renders for a CSS virtual module id. */
const REGION_MARKER = /\/\/#region \\0dsh-(?:global-css|inline-css|css):([^\n]+)\.mjs/g

/** Matches the trailing map reference a bundler appends when it emitted a sourcemap. */
const SOURCEMAP_REFERENCE = /\/\/#\s*sourceMappingURL=/u

/** Every injected stylesheet body, delimited by the region Rolldown renders for its id. */
function injectedStylesheets(code) {
  const blocks = []
  const marker = /\/\/#region \\0dsh-(?:global-css|inline-css|css):[^\n]*\n/g
  for (const match of code.matchAll(marker)) {
    const start = match.index + match[0].length
    const end = code.indexOf('//#endregion', start)
    blocks.push(code.slice(start, end < 0 ? code.length : end))
  }
  return blocks
}

/** Whether a path string is absolute on POSIX or Windows. */
function looksAbsolute(path) {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
}

/**
 * The client artifact's portable-shape problems, checked against emitted code.
 * An empty array means the artifact is portable, carries no reference to a map it
 * does not ship, and is still shaped like a DSH client bundle.
 * @param code - emitted `lib/client.js` text (or the in-memory chunk).
 * @param roots - absolute build roots that must not appear in the artifact.
 * @returns human-readable problem descriptions.
 */
export function clientArtifactProblems(code, roots) {
  const problems = []
  for (const root of roots) {
    if (typeof root === 'string' && root !== '' && code.includes(root)) problems.push(`leaks the build root ${root}`)
  }
  // The map is never in the published tarball, so the reference is a guaranteed browser
  // 404 on every page load and buys nothing once the map is absent. Re-enabling
  // `sourcemap` in the client config must fail here instead of restoring it silently.
  if (SOURCEMAP_REFERENCE.test(code)) {
    problems.push('references a source map that the package does not ship (sourceMappingURL) — the client bundle is built without one')
  }
  // The mechanism behind the fix, pinned directly: a CSS virtual id must carry a
  // RELATIVE path, or the `[hash]` filename and the `//#region` marker both move
  // with the checkout again. Rolldown writes the id verbatim, with the NUL of the
  // virtual prefix escaped as the two characters `\0`.
  for (const match of code.matchAll(REGION_MARKER)) {
    if (looksAbsolute(match[1])) problems.push(`CSS module virtual id is absolute: ${match[1]}`)
  }
  if (!code.includes('window.__ModuleLoader__.load(')) problems.push('lost the window.__ModuleLoader__.load(...) handoff')
  const stylesheets = injectedStylesheets(code)
  if (stylesheets.length === 0) problems.push('lost the plugin-owned style injection')
  if (!code.includes('data-plugin-css=')) problems.push('lost the data-plugin-css dedup key')
  let mapped = 0
  for (const block of stylesheets) {
    // Only the tail after the CSS literal: a `"key": "value"` pair inside the CSS
    // text itself is an escaped-quote sequence, not a class-map entry.
    const cssLiteral = /\bconst \w+ = ("(?:[^"\\]|\\.)*");/.exec(block)
    const css = cssLiteral === null ? undefined : JSON.parse(cssLiteral[1])
    const tail = cssLiteral === null ? block : block.slice(cssLiteral.index + cssLiteral[0].length)
    for (const entry of tail.matchAll(/"([^"\\]+)"\s*:\s*"([^"\\]+)"/g)) {
      mapped += 1
      if (css !== undefined && !css.includes(entry[2])) {
        problems.push(`class map entry ${entry[1]} → ${entry[2]} is not in the injected CSS`)
      }
    }
  }
  if (mapped === 0) problems.push('lost the CSS Modules class map')
  return problems
}
