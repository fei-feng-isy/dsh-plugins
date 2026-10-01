import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRepo } from '../src/git.js'

/**
 * `GitRepo` — the reusable git wrapper behind `knowledge.git` (and, later, any other store
 * artifact worth sharing).
 *
 * The load-bearing property is NOT "it commits" but "it can never break a write path": the caller
 * gets here only after its real mission is durable (the row is committed, the document is indexed),
 * so every failure mode — no `git`, no repo yet, a locked index, nothing to commit — has to end in
 * a warn at most. Those paths are tested directly, not assumed.
 *
 * Git is a hard dependency of these cases, so they SKIP where it is absent rather than fail: the
 * wrapper's contract is precisely "git missing is survivable", and a test that cannot run must not
 * pretend otherwise.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const subjects = (root: string): string[] =>
  execFileSync('git', ['log', '--pretty=format:%s'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

const tracked = (root: string): string[] =>
  execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

describe.skipIf(!hasGit)('GitRepo', () => {
  let root: string
  const warns: string[] = []
  const logger = { info() {}, warn: (m: string) => warns.push(m), error() {} }

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'avantf-git-')), 'corpus')
    mkdirSync(root, { recursive: true })
    warns.length = 0
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('inits on the first commit, then commits each change exactly once', () => {
    const git = new GitRepo({ root, logger })
    writeFileSync(join(root, 'a.md'), '一')
    git.commit('ingest: d/s/a')
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(subjects(root)).toEqual(['ingest: d/s/a'])

    // Nothing changed: `git add` + `git commit` would fail here, which is why the status gate
    // exists. A re-ingest of identical text reaches this path routinely.
    git.commit('ingest: d/s/a')
    expect(subjects(root)).toEqual(['ingest: d/s/a'])

    writeFileSync(join(root, 'a.md'), '二')
    git.commit('sync: d/s/a')
    expect(subjects(root)).toEqual(['sync: d/s/a', 'ingest: d/s/a'])
    expect(git.history()).toEqual(['sync: d/s/a', 'ingest: d/s/a'])
  })

  it('records a deletion, which is the change worth being able to undo', () => {
    const git = new GitRepo({ root, logger })
    writeFileSync(join(root, 'a.md'), '一')
    git.commit('ingest: d/s/a')
    rmSync(join(root, 'a.md'))
    git.commit('remove: d/s/a')
    // The content exists nowhere else once the file is gone; this is the only way back.
    expect(execFileSync('git', ['show', 'HEAD~1:a.md'], { cwd: root, encoding: 'utf8' })).toBe('一')
  })

  it('marks every automatic commit with a trailer, whatever the author', () => {
    const git = new GitRepo({ root, logger })
    writeFileSync(join(root, 'a.md'), '一')
    git.commit('ingest: d/s/a')
    // The author stays whoever the machine is (here: this developer's global identity); the trailer
    // is what separates an automatic commit from one the user made by hand.
    const body = execFileSync('git', ['log', '-1', '--pretty=format:%B'], { cwd: root, encoding: 'utf8' })
    expect(body).toContain('Automatic: avantf-mem')
    expect(body.startsWith('ingest: d/s/a')).toBe(true)
  })

  it('falls back to a repo-LOCAL bot identity only when the machine has none', () => {
    // The machine running this suite HAS a global identity (the developer's), so the fallback can
    // only be reached by hiding it: point git at empty global/system config files for the duration.
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = join(root, 'empty-global')
    process.env.GIT_CONFIG_SYSTEM = join(root, 'empty-system')
    try {
      const git = new GitRepo({ root, logger })
      writeFileSync(join(root, 'a.md'), '一')
      git.commit('ingest: d/s/a')
      expect(execFileSync('git', ['log', '-1', '--pretty=format:%an <%ae>'], { cwd: root, encoding: 'utf8' }))
        .toBe('avantf-mem <avantf-mem@localhost>')
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved.global
      if (saved.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = saved.system
    }
  })

  it('does nothing at all when the mode is off', () => {
    const git = new GitRepo({ root, mode: 'off', logger })
    expect(git.enabled).toBe(false)
    writeFileSync(join(root, 'a.md'), '一')
    git.commit('ingest: d/s/a')
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(git.history()).toEqual([])
    expect(warns).toEqual([])
  })

  it('never throws: a missing root, and a root that cannot hold a repo', () => {
    expect(() => new GitRepo({ root: join(root, 'nope'), logger }).commit('x')).not.toThrow()
    const notADir = join(root, 'file.md')
    writeFileSync(notADir, 'x')
    expect(() => new GitRepo({ root: notADir, logger }).commit('x')).not.toThrow()
    expect(warns.length).toBeGreaterThan(0)
    // Whichever stage failed (creating vs committing), the message names the stage and states that
    // the data is unaffected — the point is that it is a warn, not a throw.
    expect(warns[0]).toMatch(/git (创建|提交)失败/)
    expect(warns[0]).toContain('数据本身不受影响')
  })

  it('writes the ignore list on creation and keeps matching files out of the history', () => {
    // The whole point of `root` being configurable: pointing it at a STORE directory brings the
    // SQLite files along, and those must never enter the history.
    const git = new GitRepo({ root, ignore: ['*.db', '*.db-wal', '*.db-shm'], logger })
    writeFileSync(join(root, 'knowledge.db'), 'binary')
    writeFileSync(join(root, 'knowledge.db-wal'), 'binary')
    writeFileSync(join(root, 'a.md'), '正文')
    git.commit('ingest: d/s/a')
    expect(tracked(root)).toEqual(['.gitignore', 'a.md'])
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('*.db')
  })

  it('never overwrites an existing .gitignore', () => {
    writeFileSync(join(root, '.gitignore'), '# 用户自己写的\nsecret.md\n')
    const git = new GitRepo({ root, ignore: ['*.db'], logger })
    writeFileSync(join(root, 'secret.md'), '不该进来')
    writeFileSync(join(root, 'a.md'), '正文')
    git.commit('ingest: d/s/a')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('# 用户自己写的\nsecret.md\n')
    // Their file stays theirs and is itself tracked; what must NOT appear is what it excludes.
    expect(tracked(root)).toEqual(['.gitignore', 'a.md'])
  })
})

describe.skipIf(!hasGit)('the knowledge store commits its corpus as it changes', () => {
  it('ingest creates the repo and a commit; remove commits the deletion', async () => {
    const { buildRuntime } = await import('../src/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'avantf-git-store-'))
    const rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    try {
      const docs = join(dir, 'knowledge', 'docs')
      await rt.knowledge.ingest('正文', 'design', 'spec', '会改的文档')
      expect(subjects(docs)).toEqual(['ingest: design/spec/会改的文档'])

      const { doc_id } = rt.knowledge.list()[0] as { doc_id: number }
      rt.knowledge.remove(doc_id)
      expect(subjects(docs)[0]).toBe('remove: design/spec/会改的文档')
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a directory import makes ONE commit, not one per file', async () => {
    // R2-2: `importPaths` → `ingest` → `writeManagedFile` used to commit (3–5 git subprocesses) and
    // re-take the whole corpus baseline per file, so 200 files meant 200 commits and O(N²) stats.
    const { buildRuntime } = await import('../src/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'avantf-git-batch-'))
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    for (const name of ['a', 'b', 'c']) writeFileSync(join(src, `${name}.md`), `# ${name}\n\n正文 ${name}\n`)
    // The walk has to be allowed to read outside the process cwd (the suite runs in packages/core).
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    mkdirSync(join(dir, 'configs'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'knowledge.yaml'), 'ingest:\n  allow_outside_workspace: true\n')
    const rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    try {
      const result = await rt.knowledge.importPaths([src], 'design', 'spec')
      expect(result.imported).toHaveLength(3)
      const docs = join(dir, 'knowledge', 'docs')
      const subjects = execFileSync('git', ['log', '--pretty=format:%s'], { cwd: docs, encoding: 'utf8' })
        .split('\n').filter(Boolean)
      expect(subjects).toHaveLength(1)
      expect(subjects[0]).toContain('import: design/spec')
      // All three files are in that single commit.
      expect(execFileSync('git', ['ls-files'], { cwd: docs, encoding: 'utf8' }).split('\n').filter(Boolean))
        .toEqual(expect.arrayContaining(['design/spec/a.md', 'design/spec/b.md', 'design/spec/c.md']))
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the managed file is what the commit records, verbatim', async () => {
    const { buildRuntime } = await import('../src/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'avantf-git-body-'))
    const rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    try {
      const body = '# 标题\n\n正文内容\n'
      const result = await rt.knowledge.ingest(body, 'design', 'spec', '正文逐字节')
      expect(result.file).toBeDefined()
      // The committed blob equals the ingested text: frontmatter is prepended, the body is not
      // rewritten (an appended newline once made every document read as stale).
      const committed = execFileSync('git', ['show', 'HEAD:design/spec/正文逐字节.md'], {
        cwd: join(dir, 'knowledge', 'docs'),
        encoding: 'utf8',
      })
      expect(committed.endsWith(body)).toBe(true)
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
