import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AvantfLogger } from '@avantf/mem-contract'

/**
 * A reusable git wrapper for the stores' on-disk artifacts.
 *
 * It is deliberately root-agnostic: the knowledge corpus (`knowledge.docs.dir`, the default root)
 * is one use, and "share a whole store" is another — point `root` at `~/.avantf/knowledge` or
 * `~/.avantf` and pass an `ignore` list so the databases stay out of the history. The caller owns
 * WHAT is versioned; this owns HOW, and nothing else in the codebase needs to know git exists.
 *
 * THREE PROPERTIES ARE LOAD-BEARING, and they are why this is not just `execFileSync` at each
 * call site:
 *
 *  - **It never throws.** Every caller writes here AFTER its real work is durable (the row is
 *    committed, the document is indexed). A missing `git`, a locked index, or an unwritable repo
 *    must not turn a successful operation into a failed one — so failures are warned and swallowed,
 *    the same rule `IngestResult.file_error` follows for the managed file itself.
 *  - **It is always recognisable as automatic, and never invents an identity.** Every commit
 *    carries the `Automatic: avantf-mem` trailer. When the machine has an identity the commit is
 *    authored with it (the repo is the user's, and they may commit in it by hand — attributing
 *    their machine's work to a bot by default would be the wrong kind of surprise); when it has
 *    NONE, the repo gets a LOCAL bot identity rather than failing or writing to the user's GLOBAL
 *    config, which is what lets the commit happen at all.
 *  - **It never commits an empty change.** `git status --porcelain` gates the commit, because
 *    `git add` + `git commit` with nothing staged fails, and a store write that changed nothing
 *    (a re-ingest of identical text) is common.
 */
export type GitMode = 'auto' | 'off'

const DEFAULT_IDENTITY = { name: 'avantf-mem', email: 'avantf-mem@localhost' }

/** Appended to every automatic commit, so `git log --grep` can separate them from a user's own. */
export const AUTOMATIC_TRAILER = 'Automatic: avantf-mem'

/** Bounded so a hung `git` (an index lock held by another process) cannot stall a write path. */
const DEFAULT_TIMEOUT_MS = 10_000

export interface GitRepoOptions {
  /** The directory this repo tracks. `init`/`commit` no-op when it does not exist. */
  root: string
  /** `auto` (default) = create the repo on first commit; `off` = never invoke git at all. */
  mode?: GitMode
  /**
   * Patterns written to `.gitignore` when the repo is CREATED. An existing `.gitignore` is left
   * alone. Only matters when `root` is broader than a text directory — e.g. pointing at a store
   * directory brings the SQLite files with it, and those must never enter the history.
   */
  ignore?: readonly string[]
  /** Committer used when the machine has no identity. Defaults to the avantf bot. */
  identity?: { name: string; email: string }
  logger?: AvantfLogger
  timeoutMs?: number
}

export class GitRepo {
  readonly root: string
  private readonly mode: GitMode
  private readonly ignore: readonly string[]
  private readonly identity: { name: string; email: string }
  private readonly logger?: AvantfLogger
  private readonly timeoutMs: number

  constructor(options: GitRepoOptions) {
    this.root = options.root
    this.mode = options.mode ?? 'auto'
    this.ignore = options.ignore ?? []
    this.identity = options.identity ?? DEFAULT_IDENTITY
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Whether git is in play at all (a disabled repo does nothing, silently and by design). */
  get enabled(): boolean {
    return this.mode !== 'off'
  }

  /**
   * Create the repository if it is not one yet (writing `.gitignore` when it does). Idempotent and
   * never throws; returns whether a repository exists afterwards.
   */
  init(): boolean {
    if (!this.enabled || !existsSync(this.root)) return false
    try {
      if (!existsSync(join(this.root, '.git'))) {
        this.git(['init', '-q'])
        this.writeIgnore()
        this.logger?.info(`git 仓库已创建：${this.root}（远程与推送由你自己决定）`)
      }
      return true
    } catch (error) {
      this.warn('创建', error)
      return false
    }
  }

  /** Stage and commit whatever changed under `root`. No-op when nothing did. Never throws. */
  commit(message: string): void {
    if (!this.enabled) return
    try {
      if (!this.init()) return
      this.ensureIdentity()
      if (this.git(['status', '--porcelain']).trim() === '') return
      // `add -A` is safe because the caller scopes `root` to something that IS the artifact set;
      // anything it must not track belongs in `ignore`.
      this.git(['add', '-A'])
      // The trailer is what makes an automatic commit recognisable in `git log` regardless of WHO
      // it is attributed to. Authoring it as the machine's user is deliberate (the repo is theirs
      // and they may commit in it by hand); the trailer is what keeps the two apart.
      this.git(['commit', '-q', '-m', `${message}\n\n${AUTOMATIC_TRAILER}`])
    } catch (error) {
      this.warn('提交', error)
    }
  }

  /** Commit subjects, newest first. `[]` when git is off, absent, or the repo has no commits. */
  history(limit = 20): string[] {
    if (!this.enabled || !existsSync(join(this.root, '.git'))) return []
    try {
      return this.git(['log', `-${String(limit)}`, '--pretty=format:%s'])
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** Current branch, or `null` when unavailable (never throws — this is diagnostics only). */
  branch(): string | null {
    if (!this.enabled) return null
    try {
      const name = this.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      return name === '' ? null : name
    } catch {
      return null
    }
  }

  private ensureIdentity(): void {
    // `--get` exits 1 when unset, so the empty-string check has to sit behind its own guard.
    let email = ''
    try {
      email = this.git(['config', '--get', 'user.email']).trim()
    } catch {
      email = ''
    }
    if (email !== '') return
    // LOCAL (`--local` is implied by a plain set inside a repo) on purpose: an automatic commit
    // must not be attributed to the user, and their global config is not ours to write.
    this.git(['config', 'user.email', this.identity.email])
    this.git(['config', 'user.name', this.identity.name])
  }

  private writeIgnore(): void {
    if (this.ignore.length === 0) return
    const file = join(this.root, '.gitignore')
    if (existsSync(file)) return
    writeFileSync(file, `# 由 avantf-mem 创建：这些文件不进入历史。\n${this.ignore.join('\n')}\n`, 'utf8')
  }

  private warn(what: string, error: unknown): void {
    this.logger?.warn(
      `git ${what}失败（数据本身不受影响）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      timeout: this.timeoutMs,
      // stdin ignored, both streams captured: a chatty git must not write into the host's stdout.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}
