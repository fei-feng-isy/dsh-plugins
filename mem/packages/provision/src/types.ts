/**
 * `@avantf/mem-provision` — the ONE entry point for obtaining the external things this project
 * depends on but cannot install through pnpm.
 *
 * npm dependencies are pnpm's job and deliberately out of scope here. What this package owns is the
 * other half: third-party BINARIES and, through the same registry, derived runtime state such as the
 * warmed embedding model. They share one registry because they share one lifecycle — resolved at
 * plugin mount, fetched on first use into `~/.avantf/tools/<tool>/<version>/`, reported per artifact
 * in the startup log, and `ensure`d again at the moment of use so a missing artifact is a named
 * error rather than a silent degradation.
 *
 * The shape mirrors the converter registry in `@avantf/mem-convert` (`Artifact` ↔
 * `MarkdownConverter`, `registerArtifact`/`artifacts`/`ensure`), because the two problems are the
 * same shape: a set of things that each know how to recognize their own input, registered in
 * precedence order, reached through one function.
 *
 * This package is deliberately standalone: it depends on no engine package (a generic library about
 * downloading files), so nothing here imports `@avantf/mem-*`.
 *
 * @module types
 */

/** Which release pack applies to the running machine. */
export interface PlatformKey {
  /** `process.platform` — `linux` | `darwin` | `win32` | … */
  os: string
  /** `process.arch` normalized to `x64` | `arm64` | `arm` | `ia32`. */
  arch: string
}

/** The tool settings this package reads (`tools` in the merged config). */
export interface ProvisionConfig {
  /** Managed install root. `~`/`~/.avantf` placeholders are expanded by {@link resolveToolsDir}. */
  dir: string
  /**
   * Mirror URL templates, tried in order BEFORE the official source is tried. A template holds the
   * original URL in `{url}`; `{file}` for the bare file name is also available.
   */
  mirror: readonly string[]
  /** Download a missing artifact at startup. `false` fails with an explicit error instead. */
  auto_install: boolean
}

/**
 * One macOS/Windows/Linux release pack.
 *
 * Both sizes and the digest are REQUIRED. A missing sha256 would make the download unverifiable,
 * which is exactly the silent-degradation failure this package exists to prevent: the value is
 * recorded with its source in the artifact's module comment, not discovered at run time.
 */
export interface ArchivePack {
  url: string
  /** Expected SHA-256 of the archive, lowercase hex. */
  sha256: string
  /** Archive size in bytes — a cheap pre-flight against a truncated or HTML-error response. */
  bytes: number
  /** How the archive is unpacked. This package installs archives, never a bare executable file:
   * every release it consumes (pandoc's tarball and zip) is one, and a `binary` kind would need its
   * own download/verify/layout path for a case that does not exist. */
  format: 'tar.gz' | 'zip'
  /**
   * Path of the executable inside the extracted tree, using `/` separators. It is copied (mode
   * preserved) to `<version>/bin/<binary>`, which is the stable location callers get back.
   * Absent = the archive's root IS the executable.
   */
  binary?: string
}

/** An artifact's per-platform packs; a platform with no pack is "unsupported, here is why". */
export type PlatformPacks = Partial<Record<string, ArchivePack>>

/** Options for one {@link Artifact.ensure} call. */
export interface EnsureOptions {
  /**
   * Do not touch the network. Used where a caller only wants to READ an already-provided artifact
   * and refuse loudly instead of installing (the CLI's `--no-install` path and the tests).
   */
  offline?: boolean
  /**
   * A signal that the host has finished booting. Resolve before spending CPU or bandwidth: the
   * embedding warm-up and the tokenizer parse are main-thread work, and the plugin mount is racing
   * the harness's own startup. A rejected/hung signal must not block forever.
   */
  waitFor?: Promise<unknown>
  /** Hard cap on {@link waitFor} (ms). */
  waitForCapMs?: number
  /** Where each artifact reports what it did. */
  logger?: ProvisionLogger
  /**
   * Artifact-specific environment, visible to `isPresent`/`location` for the duration of the call.
   *
   * The `Artifact` interface has no constructor (artifacts are module-level constants, like the
   * converters), but a binary artifact needs to know the managed root to answer "are you already
   * here?". Passing it per call keeps that state explicit instead of in module scope, where two
   * runtimes pointed at two data homes would silently share one answer.
   */
  artifactEnv?: unknown
}

/** The logger surface this package needs — the slice of `@avantf/mem-contract`'s AvantfLogger. */
export interface ProvisionLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * One acquirable dependency.
 *
 * `isPresent` must answer for the WHOLE artifact, not for one candidate location: with the managed
 * copy missing but a system install on PATH, `isPresent` is `true` and `ensure` must not download.
 * `install` is only ever called when nothing is present (or when `force` is asked for).
 */
export interface Artifact {
  /** Stable id, unique in the registry; also the tool directory name and the log tag. */
  id: string
  /**
   * Human-facing one-liner for `ensure`'s failure message and the startup log. Chinese: the text
   * ends up in front of the user when an artifact cannot be provided.
   */
  title: string
  /**
   * Pinned version for versioned artifacts (`~/.avantf/tools/<id>/<version>/`); omitted by
   * artifacts that own their own layout (the model cache keeps the upstream cache directory shape).
   */
  version?: string
  /** Per-platform release packs, keyed `linux-x64` etc. Omitted by layout-less artifacts. */
  packs?: PlatformPacks
  /**
   * What `install` is DOING, for the sweep's log line: `${verb}中` / `${verb}完成`.
   *
   * One word cannot fit every artifact, and the wrong word reads like a defect: pandoc is a real
   * one-time **安装** (downloaded into a versioned directory), while the model's `install` is the
   * semantic warm-up — rebuilt in every process from the local cache — which printed "开始安装"
   * on every single start and made a working cache look like a missing dependency. Default `安装`.
   */
  verb?: string
  /** Is the artifact usable RIGHT NOW, without fetching anything? */
  isPresent(artifactEnv?: unknown): Promise<boolean>
  /** Acquire it. Throws {@link ProvisionError} with the failed step named. */
  install(ctx: InstallContext): Promise<void>
  /** Prove the acquired artifact actually runs. Throws with the observed output. */
  verify(ctx: VerifyContext): Promise<void>
  /**
   * Where the artifact currently is, for the startup log and a UI capability line — optional,
   * because an artifact that owns no directory of its own (the model warm-up) has nothing to say.
   * Best-effort: a throw here is swallowed by the sweep and simply omits the location.
   */
  location?(ctx: { toolsDir: string; artifactEnv?: unknown }): Promise<string | undefined>
}

/** What {@link Artifact.install} is handed: the resolved managed root and the chosen pack. */
export interface InstallContext {
  /** The artifact's version directory (`<tools>/<id>/<version>`, already created). */
  dir: string
  /** The resolved pack for this machine; ABSENT for a layout-less artifact (no `packs`). */
  pack?: ArchivePack
  /** Where to download (a temporary file inside a scratch directory). */
  fetch: (url: string, dest: string) => Promise<void>
  config: ProvisionConfig
  logger: ProvisionLogger
  /**
   * Whatever the caller passed as {@link EnsureArtifactOptions.artifactEnv}, forwarded unchanged.
   *
   * The model artifact owns no layout of its own — its `install` IS the semantic warm-up, which
   * needs the runtime that owns the model cache. Dropping this field meant `install` ran without the
   * one thing it needs, so the model reported "需要 artifactEnv.runtime" on EVERY start and retrieval
   * quietly fell back to FTS+entity even with downloads enabled and the model cached.
   */
  artifactEnv?: unknown
}

/** What {@link Artifact.verify} is handed. */
export interface VerifyContext {
  /** The artifact's version directory. */
  dir: string
  logger: ProvisionLogger
  /** The same `artifactEnv` {@link InstallContext} received (see {@link EnsureOptions.artifactEnv}). */
  artifactEnv?: unknown
}

/** The outcome of one {@link ensure} call, for the startup log. */
export interface EnsureResult {
  id: string
  ok: boolean
  /** Where the artifact is, when it is a binary/layout artifact knows its own location. */
  location?: string
  /** How the artifact was resolved: managed dir, a system installation, or a fresh install. */
  source?: ArtifactSource
  /** `error.message` when `ok` is false. */
  error?: string
  elapsedMs: number
}

/** Where an artifact was found. Explicit config and managed installs beat a system one. */
export type ArtifactSource = 'explicit' | 'managed' | 'system' | 'installed'
