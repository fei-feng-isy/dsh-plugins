/**
 * The pandoc artifact: a pinned, statically linked pandoc in `~/.avantf/tools/pandoc/<version>/`.
 *
 * WHY PANDOC IS A DEPENDENCY OF USING THIS PLUGIN. Every document→Markdown conversion in the
 * knowledge base goes through it, so the same `.docx` produces the same Markdown on every machine.
 * The mammoth+Turndown pair it replaced rendered a document differently (and differently again from
 * Word), so a corpus ingested on one machine was not reproducible on another — the cross-machine
 * divergence this module exists to remove.
 *
 * VERSION. `PANDOC_VERSION` is pinned in code, not read from the release feed: a build that silently
 * followed upstream would change the corpus without a commit. Bumping it means re-recording the
 * digests below, which is the intended friction.
 *
 * DIGESTS. Recorded by measurement, because pandoc publishes no checksums file next to its release
 * assets (the 3.11 release page carries the tarball/zip/deb/pkg and nothing to verify them against —
 * confirmed by listing the release assets through the GitHub API on 2026-09-17). Each `sha256` below
 * is the digest of the file fetched from that `url` on 2026-09-17, verified twice from this host
 * (curl and Node's `fetch` agreeing on both the byte count and the digest). Re-record with
 * `sha256sum <file>` after downloading from the official release URL, and update the date here when
 * bumping the version.
 *
 * PLATFORMS. Linux uses the STATICALLY LINKED tarball (`ldd` reports "not a dynamic executable", and
 * it runs under `env -i`, so it does not depend on this host's glibc — which is what makes it safe to
 * keep in a user directory); macOS uses the zip (the pkg would run an installer, which a managed
 * directory must not do); Windows uses the zip, never the msi (same reason). Extracted binary paths,
 * measured:
 *   pandoc-3.11-linux-amd64.tar.gz → pandoc-3.11/bin/pandoc
 *   pandoc-3.11-*-macOS.zip        → pandoc-3.11-<arch>/bin/pandoc
 *   pandoc-3.11-windows-x86_64.zip → pandoc-3.11/pandoc.exe
 * Linux arm64 has no pack: its digest was never measured on this machine, and a pack with an
 * unverified digest is worse than an explicit "unsupported platform" (see `packFor`).
 *
 * @module artifacts/pandoc
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultToolsDir } from '../config.js'
import { ProvisionError } from '../errors.js'
import {
  artifactById,
  ensure,
  hasArtifact,
  INSTALL_MANIFEST,
  registerArtifact,
  requirePack,
  resolveBinary,
  type EnsureArtifactOptions,
} from '../registry.js'
import { installBinaryArtifact, runProbe, versionDir } from '../tools.js'
import type { Artifact, EnsureResult, PlatformPacks, ProvisionLogger } from '../types.js'

/** The pinned pandoc version. Bump together with the digests below. */
export const PANDOC_VERSION = '3.11'

/** The artifact id; also the managed directory name and the `converter` prefix (`pandoc-3.11`). */
export const PANDOC_ARTIFACT_ID = 'pandoc'

/** The executable name. */
export const PANDOC_BINARY = 'pandoc'

/** The `converter` string reported by the converter and written to frontmatter. */
export function pandocConverterId(): string {
  return `${PANDOC_ARTIFACT_ID}-${PANDOC_VERSION}`
}

/**
 * The `--version` marker that must appear in the probe's output.
 *
 * `pandoc 3.11` is the real first line (measured). Matching the number rather than the whole line
 * keeps the check stable across a trailing build suffix and still distinguishes 3.11 from 3.1.
 */
export const PANDOC_VERSION_MARKER = PANDOC_VERSION

/** Everything resolution and the version probe need. */
export const PANDOC_SPEC = {
  binary: PANDOC_BINARY,
  versionArgs: ['--version'],
  versionMarker: PANDOC_VERSION_MARKER,
  envVar: 'AVANTF_PANDOC',
  configPath: 'knowledge.convert.pandoc',
} as const

/** What the artifact needs to answer `isPresent`/`location`: the managed root and an explicit path. */
export interface PandocEnv {
  toolsDir: string
  explicit?: string
}

/** One release pack per platform we can actually verify, with the digest measured on 2026-09-17. */
export const PANDOC_PACKS: PlatformPacks = {
  'linux-x64': {
    url: 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-linux-amd64.tar.gz',
    sha256: '37edb3bbcf722f921a009941bf5874e2e0c09263226c9b4a2d980788cb062ab6',
    bytes: 34_940_580,
    format: 'tar.gz',
    binary: 'pandoc-3.11/bin/pandoc',
  },
  'darwin-x64': {
    url: 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-x86_64-macOS.zip',
    sha256: '3b1c1b57f160112c821d02f23d946ede8b7f57a6ccf4632a25a512d334a9291f',
    bytes: 26_145_603,
    format: 'zip',
    binary: 'pandoc-3.11-x86_64/bin/pandoc',
  },
  'darwin-arm64': {
    url: 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-arm64-macOS.zip',
    sha256: '15806bedf9517bfead72e88fe6a6696635c3691efbb6e152173440e9c5bb50b4',
    bytes: 41_832_712,
    format: 'zip',
    binary: 'pandoc-3.11-arm64/bin/pandoc',
  },
  'win32-x64': {
    url: 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-windows-x86_64.zip',
    sha256: '2ab72baf2399450e148ddf7a2a8689806c42e1bba71862b57e220fd9b8456d3d',
    bytes: 41_761_100,
    format: 'zip',
    binary: 'pandoc-3.11/pandoc.exe',
  },
}

/** Where the managed copy of the pinned version lives (whether or not it exists yet). */
export function managedPandocPath(toolsDir: string): string {
  return join(versionDir(toolsDir, PANDOC_ARTIFACT_ID, PANDOC_VERSION), 'bin', PANDOC_BINARY)
}

/** Read the env `ensure` stashed for this artifact; `undefined` means "no directory known". */
function pandocEnv(artifactEnv: unknown): PandocEnv | undefined {
  if (artifactEnv === null || typeof artifactEnv !== 'object') return undefined
  const env = artifactEnv as PandocEnv
  return typeof env.toolsDir === 'string' ? env : undefined
}

/** `<tools>/<id>/<version>` → `<tools>` (this module owns the layout, so it undoes it here). */
function toolsDirOfVersionDir(dir: string): string {
  return join(dir, '..', '..')
}

/** The artifact as the registry sees it. */
export const pandocArtifact: Artifact = {
  id: PANDOC_ARTIFACT_ID,
  title: `pandoc ${PANDOC_VERSION}（文档转换）`,
  version: PANDOC_VERSION,
  packs: PANDOC_PACKS,

  /**
   * `isPresent` answers for the WHOLE artifact, using the same fixed order `resolveBinary` uses: an
   * explicit path, then the managed copy, then a matching version on PATH. It never installs and
   * never mutates anything — that is `install`'s job.
   */
  async isPresent(artifactEnv?: unknown): Promise<boolean> {
    const env = pandocEnv(artifactEnv)
    // A sweep that did not carry the resolved config still gets an honest answer: the managed
    // default directory and `PATH` are checked, so an already-provisioned tool is never re-downloaded.
    return pandocExecutable(env?.toolsDir ?? defaultToolsDir(), env?.explicit).ok
  },

  async install(ctx): Promise<void> {
    // Pandoc DECLARES packs, so the registry resolved one before calling this; `requirePack` turns
    // the optional field back into the required type without a non-null assertion.
    const pack = requirePack(ctx, PANDOC_ARTIFACT_ID)
    const toolsDir = toolsDirOfVersionDir(ctx.dir)
    await installBinaryArtifact({
      artifact: PANDOC_ARTIFACT_ID,
      toolsDir,
      version: PANDOC_VERSION,
      binary: PANDOC_BINARY,
      pack,
      config: ctx.config,
      logger: ctx.logger,
    })
    // Record what was installed and where it came from. This file is also what tells a FETCHED tool
    // directory from a hand-placed one (the latter simply lacks it).
    writeFileSync(
      join(toolsDir, PANDOC_ARTIFACT_ID, PANDOC_VERSION, INSTALL_MANIFEST),
      `${JSON.stringify({
        id: PANDOC_ARTIFACT_ID,
        version: PANDOC_VERSION,
        binary: PANDOC_BINARY,
        url: pack.url,
        sha256: pack.sha256,
        installed_at: new Date().toISOString(),
      }, null, 2)}\n`,
    )
  },

  async verify(ctx): Promise<void> {
    const binary = join(ctx.dir, 'bin', PANDOC_BINARY)
    if (!existsSync(binary)) {
      throw new ProvisionError('verify-binary', PANDOC_ARTIFACT_ID, `安装后 ${binary} 不存在`)
    }
    const probe = runProbe(binary, PANDOC_SPEC.versionArgs)
    if (!probe.ok) {
      throw new ProvisionError('verify-binary', PANDOC_ARTIFACT_ID, `${binary} 无法执行：${probe.output}`)
    }
    if (!probe.output.includes(PANDOC_VERSION_MARKER)) {
      throw new ProvisionError(
        'verify-binary',
        PANDOC_ARTIFACT_ID,
        `${binary} 报告的版本不含 ${PANDOC_VERSION_MARKER}：${probe.output.split('\n')[0] ?? ''}`,
      )
    }
  },

  /** For the startup log/UI: where the resolved executable is, without installing. */
  async location(ctx: { toolsDir: string; artifactEnv?: unknown }): Promise<string | undefined> {
    const env = pandocEnv(ctx.artifactEnv)
    const resolved = pandocExecutable(ctx.toolsDir, env?.explicit)
    return resolved.ok ? `${resolved.path}（${resolved.source}）` : undefined
  },
}

/** Register the pandoc artifact once per process (idempotent for a test that mounts twice). */
export function registerPandocArtifact(): void {
  if (!hasArtifact(PANDOC_ARTIFACT_ID)) registerArtifact(pandocArtifact)
}

/** The result of resolving pandoc for use. */
export type PandocResolution =
  | { ok: true; path: string; source: 'explicit' | 'managed' | 'system' | 'installed' }
  | { ok: false; error: string }

/** What {@link ensurePandoc} needs from its caller (the runtime supplies config + logger). */
export interface PandocEnsureOptions {
  toolsDir: string
  config: {
    /** Mirror templates; the official source is always tried last. */
    mirror: readonly string[]
    /** `false` refuses to download (the caller wants a diagnosis, not an install). */
    auto_install: boolean
  }
  logger: ProvisionLogger
  /** Explicit binary path; defaults to `AVANTF_PANDOC`. */
  explicit?: string
  /** Refuse to download even when `auto_install` is true. */
  offline?: boolean
}

/**
 * Resolve the pandoc executable for a conversion, installing it if needed.
 *
 * Called at the MOMENT OF USE, not only at startup: a conversion must not silently fall back to
 * another converter because a background download had not finished when the first document arrived.
 * A failure here is one explicit error naming the tool, the reason, and the per-platform install
 * commands.
 */
export async function ensurePandoc(options: PandocEnsureOptions): Promise<PandocResolution> {
  registerPandocArtifact()
  const settings: EnsureArtifactOptions = {
    toolsDir: options.toolsDir,
    config: { dir: options.toolsDir, mirror: options.config.mirror, auto_install: options.config.auto_install },
    logger: options.logger,
    artifactEnv: { toolsDir: options.toolsDir, ...(options.explicit === undefined ? {} : { explicit: options.explicit }) } satisfies PandocEnv,
    ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
  }
  const result: EnsureResult = await ensure(PANDOC_ARTIFACT_ID, settings)
  if (!result.ok) return { ok: false, error: result.error ?? '未知错误' }
  const resolved = pandocExecutable(options.toolsDir, options.explicit)
  if (!resolved.ok) return { ok: false, error: resolved.reason }
  return { ok: true, path: resolved.path, source: resolved.source }
}

/**
 * Resolve WITHOUT installing — for diagnostics and for a caller that has already ensured it.
 *
 * The pinned version is enforced on every candidate, INCLUDING a system installation: pandoc 3.1 and
 * pandoc 3.11 render differently, so "some pandoc is on PATH" is not the property this needs. An
 * explicit path is checked the same way, because a hand-picked binary reporting a different version
 * is exactly the cross-machine divergence the pin exists to prevent.
 */
export function pandocExecutable(
  toolsDir: string,
  explicit?: string,
): { ok: true; path: string; source: 'explicit' | 'managed' | 'system' } | { ok: false; reason: string } {
  const artifact = artifactById(PANDOC_ARTIFACT_ID)
  const resolution = resolveBinary(PANDOC_SPEC, {
    toolsDir,
    artifact,
    ...(explicit === undefined ? {} : { explicit }),
  })
  if (!resolution.ok) return { ok: false, reason: resolution.reason }
  if (resolution.version !== undefined && !resolution.version.includes(PANDOC_VERSION_MARKER)) {
    return {
      ok: false,
      reason: `找到的 pandoc 版本不是 ${PANDOC_VERSION}：${resolution.version}（跨版本转换结果不可比）`,
    }
  }
  return { ok: true, path: resolution.path, source: resolution.source as 'explicit' | 'managed' | 'system' }
}

/** True when the managed copy of the pinned version exists on disk (no probe, no install). */
export function managedPandocInstalled(toolsDir: string): boolean {
  return existsSync(managedPandocPath(toolsDir))
}
