import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The CSS-module declaration is a HAND-WRITTEN key list, so it can drift from the stylesheet in
 * two directions and neither is visible at runtime:
 *
 *  - a class in the CSS but not in the declaration → `css.newThing` does not compile (loud, fine);
 *  - a class in the declaration but not in the CSS → `css.ghost` compiles and is `undefined` at
 *    runtime, so the element silently loses its styling.
 *
 * The second is what shipped as `css.detail` against a stylesheet with no `.detail` rule. This
 * test closes it by deriving the key set from the stylesheet itself. Plain file reads — no
 * `@deepseek-ai/*` import, so it runs in CI like every other harness-free unit here.
 */
const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, '..', 'src', 'client', 'pages.module.css')
const dtsPath = join(here, '..', 'src', 'css-modules.d.ts')

/** Top-level class selectors of the stylesheet (`^\\.name`), de-duplicated and sorted. */
function classesInCss(): string[] {
  const css = readFileSync(cssPath, 'utf8')
  const names = new Set<string>()
  for (const line of css.split('\n')) {
    const match = /^\.([A-Za-z][\w-]*)/.exec(line)
    if (match) names.add(match[1]!)
  }
  return [...names].sort()
}

/** The `readonly <name>: string` keys declared for `'*.module.css'`. */
function classesInDeclaration(): string[] {
  const dts = readFileSync(dtsPath, 'utf8')
  const block = /declare module '\*\.module\.css' \{([\s\S]*?)\n\}/.exec(dts)
  if (block === null) throw new Error('css-modules.d.ts: the *.module.css block is gone')
  const names = new Set<string>()
  for (const match of block[1]!.matchAll(/readonly ([A-Za-z][\w-]*):/g)) names.add(match[1]!)
  return [...names].sort()
}

describe('css module declaration', () => {
  it('declares exactly the classes the stylesheet defines', () => {
    expect(classesInDeclaration()).toEqual(classesInCss())
  })

  it('is not an index signature again (which would make every typo compile)', () => {
    // Comments are stripped first: the rationale above this declaration NAMES the rejected type,
    // and a text search over the raw file would trip on its own explanation.
    const code = readFileSync(dtsPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/Record<\s*string\s*,/)
    expect(code).not.toMatch(/\[\s*key\s*:\s*string\s*\]/)
  })
})
