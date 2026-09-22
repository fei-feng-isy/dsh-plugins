/**
 * Classifying a pasted source, and browsing for one — both under the ingestion boundary.
 *
 * The classification is what makes the 知识 tab's single input work: the browser can recognize a
 * URL and nothing else, so "is this a file, a directory, a path that does not exist, or a
 * paragraph" is answered here, against the same boundary `kb_manage ingest` enforces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { browseDirectory, classifySource, isIngestableFile, listTextFiles, splitSourceInput } from '../src/store/source_picker.js'
import type { IngestLimits } from '../src/store/ingest_guard.js'

let dir: string
let limits: IngestLimits

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-picker-'))
  // The temp home is outside the process workspace, so the boundary is opened explicitly: the
  // picker must be constrained by `local_roots`, not by wherever the test runner happens to run.
  limits = { local_roots: [dir], allow_outside_workspace: false, allow_private_network: false }
  mkdirSync(join(dir, 'docs', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'a.md'), '# A\n')
  writeFileSync(join(dir, 'docs', 'nested', 'b.pdf'), 'x')
  writeFileSync(join(dir, 'docs', 'logo.png'), 'x')
  writeFileSync(join(dir, 'loose.txt'), 'plain\n')
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('classifySource', () => {
  it('recognizes a URL outright', () => {
    expect(classifySource('https://example.com/spec.md', limits).kind).toBe('url')
    expect(classifySource('  http://example.com  ', limits).kind).toBe('url')
  })

  it('resolves a local file to its absolute, realpath-ed form', () => {
    const found = classifySource(join(dir, 'loose.txt'), limits)
    expect(found.kind).toBe('file')
    expect(found.paths).toEqual([join(dir, 'loose.txt')])
  })

  it('recognizes a directory and counts what ingestion would take from it', () => {
    const found = classifySource(join(dir, 'docs'), limits)
    expect(found.kind).toBe('directory')
    expect(found.files).toBe(2) // a.md + nested/b.pdf; logo.png is skipped by the walk
  })

  it('takes a path WITH SPACES as one path (the picker hands back exactly such paths)', () => {
    // Windows is full of them (`C:\\Users\\me\\My Documents\\a.md`), and splitting on whitespace first
    // made every one of them classify as "not found" — the picker could select a file the form then
    // refused to ingest.
    mkdirSync(join(dir, 'My Docs'))
    writeFileSync(join(dir, 'My Docs', 'a.md'), '# spaced\n')
    const file = classifySource(join(dir, 'My Docs', 'a.md'), limits)
    expect(file.kind).toBe('file')
    expect(file.paths).toEqual([join(dir, 'My Docs', 'a.md')])
    const folder = classifySource(join(dir, 'My Docs'), limits)
    expect(folder.kind).toBe('directory')
    expect(folder.files).toBe(1)
  })

  it('treats several existing paths as a path list', () => {
    const found = classifySource(`${join(dir, 'loose.txt')} ${join(dir, 'docs', 'a.md')}`, limits)
    expect(found.kind).toBe('file')
    expect(found.paths).toHaveLength(2)
    expect(splitSourceInput(`${join(dir, 'a.md')}, ${join(dir, 'b.md')}`)).toHaveLength(2)
  })

  it('reports a path-shaped input that does not exist as missing, with the reason', () => {
    const found = classifySource('~/definitely-not-here.md', limits)
    expect(found.kind).toBe('missing')
    expect(found.missing).toEqual(['~/definitely-not-here.md'])
    expect(found.reasons[0]).toMatch(/找不到/)
  })

  it('reports a path outside the allowed roots as missing, naming the boundary', () => {
    const found = classifySource('/etc/hostname', limits)
    expect(found.kind).toBe('missing')
    expect(found.reasons[0]).toMatch(/超出允许范围|允许的根/)
  })

  it('treats prose as text, however many words it has', () => {
    expect(classifySource('网关设计规范：平台组负责统一网关。', limits).kind).toBe('text')
    expect(classifySource('a paragraph with words, commas and no paths at all', limits).kind).toBe('text')
  })

  it('does not probe the filesystem for a long document', () => {
    // 3000 path-shaped tokens would be 3000 stat calls; pasted prose must not pay for that.
    const long = Array.from({ length: 3000 }, (_, i) => `word-${String(i)}.md`).join(' ')
    const found = classifySource(long, limits)
    expect(found.kind).toBe('text')
    expect(found.paths).toEqual([])
  })
})

describe('browseDirectory', () => {
  it('starts at the first allowed root, with no parent to escape to', () => {
    const listing = browseDirectory(undefined, limits)
    expect(listing.path).toBe(dir)
    expect(listing.parent).toBeNull() // the root IS the boundary
    expect(listing.roots).toEqual([dir])
  })

  it('walks the convertible extensions in, and keeps the unconvertible ones out', () => {
    const office = join(dir, 'office')
    mkdirSync(office)
    const names = ['a.docx', 'b.xlsx', 'c.html', 'd.htm', 'e.csv', 'f.pptx', 'g.epub', 'h.doc', 'i.ods', 'j.png']
    for (const name of names) writeFileSync(join(office, name), 'x')

    const walked = listTextFiles(office)
    // EPUB is now convertible (pandoc reads it), so it is walked in; pptx/OLE/ods/images are not.
    expect(walked.files.map(path => basename(path)).sort()).toEqual(['a.docx', 'b.xlsx', 'c.html', 'd.htm', 'e.csv', 'g.epub'])
    expect(walked.skipped.map(path => basename(path)).sort()).toEqual(['f.pptx', 'h.doc', 'i.ods', 'j.png'])
    // `INGESTABLE` is the single source the walk and the picker share.
    expect(isIngestableFile('x.CSV')).toBe(true)
    expect(isIngestableFile('x.pptx')).toBe(false)
  })

  it('lists directories first, then ingestable files, then everything else', () => {
    mkdirSync(join(dir, 'zzz-dir'))
    writeFileSync(join(dir, 'aaa.png'), 'x')
    const names = browseDirectory(dir, limits).entries.map(entry => `${entry.kind}:${entry.name}`)
    expect(names).toEqual([
      'dir:docs',
      'dir:zzz-dir',
      'ingestable:loose.txt',
      'other:aaa.png',
    ])
  })

  it('walks down and back up, stopping the parent chain at the root', () => {
    const nested = browseDirectory(join(dir, 'docs', 'nested'), limits)
    expect(nested.parent).toBe(join(dir, 'docs'))
    expect(nested.entries.map(entry => entry.kind)).toEqual(['ingestable'])
    // One level below the root the parent is the root; AT the root there is nothing above it.
    expect(browseDirectory(join(dir, 'docs'), limits).parent).toBe(dir)
  })

  it('refuses a directory the ingestion boundary would refuse', () => {
    expect(() => browseDirectory('/etc', limits)).toThrow(/超出允许范围|允许的根/)
  })

  it('honours allow_outside_workspace: starts at home, says so, and walks anywhere', () => {
    const open: IngestLimits = { local_roots: [], allow_outside_workspace: true, allow_private_network: false }
    const home = browseDirectory(undefined, open)
    // Not the process cwd (which for a GUI host is the DSH profile directory) — the home is where
    // an operator's documents actually are.
    expect(home.path).toBe(homedir())
    expect(home.unrestricted).toBe(true)
    expect(() => browseDirectory('/etc', open)).not.toThrow()
    // The parent chain is no longer stopped by a root, only by the filesystem's own top.
    expect(browseDirectory(dirname(homedir()), open).parent).toBe(dirname(dirname(homedir())))
  })

  it('marks a bounded listing as restricted, so the UI never claims more than it offers', () => {
    expect(browseDirectory(dir, limits).unrestricted).toBe(false)
  })

  it('refuses a file where a directory is required', () => {
    expect(() => browseDirectory(join(dir, 'loose.txt'), limits)).toThrow(/不是目录/)
  })
})

/**
 * The walk's whitelist must not drift from the formats the pipeline can actually convert.
 *
 * `INGESTABLE` decides what a directory walk OFFERS; the converters decide what the pipeline can
 * READ. If the list were narrower, a user would never see a convertible file; if it were wider, every
 * walk would offer a file that `kb_import` then reports as failed. So each entry is checked against
 * the conversion this release actually performs: every pandoc reader extension and the built-in
 * xlsx converter must be offered, and the refused formats (OLE, pptx, images) must not.
 */
describe('INGESTABLE agrees with the converter registry', () => {
  it('offers every extension the pandoc converter declares, plus the built-in xlsx converter', async () => {
    const { PANDOC_READERS, PROBE_ONLY_EXTENSIONS } = await import('@avantf/mem-convert')
    expect(PANDOC_READERS.size).toBeGreaterThan(20)
    for (const extension of PANDOC_READERS.keys()) {
      // `.xml` is claimed by the DocBook reader but is NOT walked: a directory of generic XML is not
      // a directory of documents. The two sets must still add up to the reader table, so an extension
      // can never be silently dropped from both.
      if (PROBE_ONLY_EXTENSIONS.has(extension)) continue
      expect(isIngestableFile(`报告${extension}`), extension).toBe(true)
    }
    expect([...PANDOC_READERS.keys()].filter(extension => !isIngestableFile(`x${extension}`))).toEqual([...PROBE_ONLY_EXTENSIONS])
    for (const extension of ['.md', '.markdown', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml', '.pdf', '.xlsx']) {
      expect(isIngestableFile(`报告${extension}`), extension).toBe(true)
    }
  })

  it('never offers a format the pipeline refuses', () => {
    // OLE `.doc/.xls/.ppt` are a named REFUSAL, pptx has no converter, and images/executables are
    // binaries: a walk that listed them would promise something ingestion cannot deliver.
    for (const extension of ['.doc', '.xls', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.exe', '.zip']) {
      expect(isIngestableFile(`报告${extension}`), extension).toBe(false)
    }
  })

  it('still takes an explicitly named file regardless of its extension', () => {
    // The whitelist is a WALK filter only; `classifySource` on a path resolves it and lets the
    // ingestion boundary (not this list) decide, which is the documented behaviour.
    writeFileSync(join(dir, 'export.csv'), 'a,b\n1,2\n')
    expect(classifySource(join(dir, 'export.csv'), limits).kind).toBe('file')
  })
})
