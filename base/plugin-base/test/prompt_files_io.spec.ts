import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, beforeEach } from 'vitest'
import { PromptFiles, type PromptFilesIo } from '../src/kit/prompt_files.js'

/**
 * `PromptFiles` — the reusable "user-editable prompt text" flow behind the plugin's guidance section
 * (and, later, any other store's).
 *
 * The load-bearing property is NOT "it reads a file" but "it can never break a mount": a read-only
 * data home, a directory sitting where a file should be, a permission error — each has to end in the
 * DEFAULT text plus one warning, never in a throw, because a throwing `apply` fails the whole host
 * boot. The second property is the user's ownership of the text: only a missing or blank file is
 * written, and whatever is on disk is injected verbatim.
 *
 * The filesystem is a Map, so every branch is reachable without a real directory: `fail.*` makes one
 * operation throw on demand.
 */
interface Fake {
  readonly io: PromptFilesIo
  readonly files: Map<string, string>
  readonly writes: string[]
  readonly fail: { read: boolean; write: boolean; ensureDir: boolean }
}

function fakeIo(initial: Record<string, string> = {}): Fake {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const fail = { read: false, write: false, ensureDir: false }
  const io: PromptFilesIo = {
    exists: (path) => files.has(path),
    read: (path) => {
      if (fail.read) throw new Error('EACCES: permission denied')
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: (path, text) => {
      if (fail.write) throw new Error('EROFS: read-only file system')
      files.set(path, text)
      writes.push(path)
    },
    ensureDir: () => {
      if (fail.ensureDir) throw new Error('EACCES: permission denied')
    },
  }
  return { io, files, writes, fail }
}

const DIR = '/data/prompts'
const SPEC = { file: 'work-tree-guide.md', fallback: '默认正文' }

let warnings: string[]
let infos: string[]
const logger = {
  info: (message: string) => infos.push(message),
  warn: (message: string) => warnings.push(message),
}

beforeEach(() => {
  warnings = []
  infos = []
})

describe('PromptFiles', () => {
  it('creates a missing file with the default body and returns that body', () => {
    const fake = fakeIo()
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.source).toBe('default')
    expect(loaded?.wrote).toBe(true)
    expect(loaded?.text).toBe('默认正文')
    expect(loaded?.path).toBe(`${DIR}/${SPEC.file}`)
    // The file on disk is the text, with a trailing newline so an editor opens it as a file.
    expect(fake.files.get(loaded?.path ?? '')).toBe('默认正文\n')
    expect(infos.some((line) => line.includes('created'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('fills a blank file instead of treating whitespace as an edit', () => {
    const fake = fakeIo({ [`${DIR}/${SPEC.file}`]: '   \n\n\t' })
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.text).toBe('默认正文')
    expect(loaded?.wrote).toBe(true)
    expect(fake.files.get(`${DIR}/${SPEC.file}`)).toBe('默认正文\n')
  })

  it('uses what the user wrote, verbatim, and never rewrites it', () => {
    const mine = '我的提示词：\n- 第一条\n- 第二条'
    const fake = fakeIo({ [`${DIR}/${SPEC.file}`]: `${mine}\n\n` })
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.source).toBe('file')
    expect(loaded?.wrote).toBe(false)
    expect(loaded?.text).toBe(mine)
    expect(fake.writes).toEqual([])
  })

  it('strips a BOM and normalizes CRLF, so an editor cannot inject them into the prompt', () => {
    const fake = fakeIo({ [`${DIR}/${SPEC.file}`]: '\uFEFF第一行\r\n第二行\r\n' })
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.text).toBe('第一行\n第二行')
  })

  it('falls back to the default, with one warning, when the file cannot be read', () => {
    const fake = fakeIo({ [`${DIR}/${SPEC.file}`]: 'x' })
    fake.fail.read = true
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.text).toBe('默认正文')
    expect(loaded?.source).toBe('default')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('EACCES')
  })

  it('falls back to the default when the file cannot be created, and does not throw', () => {
    const fake = fakeIo()
    fake.fail.write = true
    // `load` itself is the assertion: an uncatched EROFS would propagate out of the plugin's apply.
    const [loaded] = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([SPEC])

    expect(loaded?.text).toBe('默认正文')
    expect(loaded?.wrote).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('EROFS')
  })

  it('warns once for an unusable directory, not once per file', () => {
    const fake = fakeIo()
    fake.fail.ensureDir = true
    const loaded = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([
      { file: 'a.md', fallback: 'A' },
      { file: 'b.md', fallback: 'B' },
      { file: 'c.md', fallback: 'C' },
    ])

    expect(loaded.map((entry) => entry.text)).toEqual(['A', 'B', 'C'])
    expect(loaded.every((entry) => entry.source === 'default')).toBe(true)
    expect(warnings).toHaveLength(1)
  })

  it('keeps manifest order and trims the default it writes', () => {
    const fake = fakeIo()
    const loaded = new PromptFiles({ dir: DIR, logger, io: fake.io }).load([
      { file: 'a.md', fallback: '\n  A  \n' },
      { file: 'b.md', fallback: 'B' },
    ])

    expect(loaded.map((entry) => entry.file)).toEqual(['a.md', 'b.md'])
    expect(loaded[0]?.text).toBe('A')
    expect(fake.files.get(`${DIR}/a.md`)).toBe('A\n')
  })
})

/**
 * The same flow against the REAL filesystem.
 *
 * Everything above injects a Map, which is the right way to reach every branch — and the wrong way to
 * find out that the real writer leaves litter behind. `nodeIo.write` is the one part of this module
 * that touches a directory the USER owns (hand-edited prompt files live there), so it gets its own
 * tests: the temp file it renames through must never survive a failure, and dead siblings from an
 * earlier crash must not accumulate in `prompts/`.
 */
describe('PromptFiles over the real filesystem', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prompt-files-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file with the default body and leaves no temp behind', () => {
    const [loaded] = new PromptFiles({ dir, logger }).load([SPEC])

    expect(loaded?.source).toBe('default')
    expect(readFileSync(join(dir, SPEC.file), 'utf8')).toBe('默认正文\n')
    expect(readdirSync(dir)).toEqual([SPEC.file])
  })

  it('sweeps a DEAD temp sibling but keeps a live one', () => {
    const stale = join(dir, `${SPEC.file}.tmp-999999`)
    const live = join(dir, `${SPEC.file}.tmp-1`)
    writeFileSync(stale, 'half-written', 'utf8')
    writeFileSync(live, 'half-written', 'utf8')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(stale, old, old)

    new PromptFiles({ dir, logger }).load([SPEC])

    const left = readdirSync(dir).sort()
    // The dead one is gone; the recent one could belong to a writer that is still running.
    expect(left).toEqual([SPEC.file, `${SPEC.file}.tmp-1`].sort())
  })

  it('drops its own temp when the rename fails, and still returns the default', () => {
    // A directory sitting where the file belongs is the everyday way the rename step fails.
    mkdirSync(join(dir, SPEC.file))

    const [loaded] = new PromptFiles({ dir, logger }).load([SPEC])

    expect(loaded?.source).toBe('default')
    expect(loaded?.text).toBe('默认正文')
    expect(warnings.some((line) => line.includes(SPEC.file))).toBe(true)
    // Nothing of ours is left: the temp was removed on the way out.
    expect(readdirSync(dir)).toEqual([SPEC.file])
  })
})
