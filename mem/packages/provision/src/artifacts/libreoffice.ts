/**
 * LibreOffice: DETECTED, never installed.
 *
 * It is the only thing that can read the legacy OLE formats (`.doc`/`.xls`/`.ppt`), and its footprint
 * — several hundred MB, plus a background process model — is not something this plugin may impose on
 * a user's machine. So the rule is: if a system installation is already there, say so and let the
 * caller name it; if it is not, refuse the format with the reason instead of fetching it.
 *
 * This is a plain detection helper rather than a registry artifact because an artifact's contract is
 * "how to obtain this" — and there is deliberately no way to obtain it here.
 *
 * @module artifacts/libreoffice
 */
import { findOnPath } from '../platform.js'
import type { BinarySpec } from '../registry.js'

/** The executable name on PATH (`soffice` is the launcher on all three platforms). */
export const LIBREOFFICE_BINARY = 'soffice'

/** Detection spec. No `versionMarker`: this project does not pin LibreOffice's rendering. */
export const LIBREOFFICE_SPEC: BinarySpec = {
  binary: LIBREOFFICE_BINARY,
  versionArgs: ['--version'],
  envVar: 'AVANTF_SOFFICE',
}

/** Why the legacy formats are refused, and what would read them. One string, used in two places. */
export const LEGACY_OFFICE_HINT =
  '旧版 .doc/.xls/.ppt 是 OLE 复合文档，pandoc 读不了；本项目不自动安装 LibreOffice（数百 MB），'
  + '只有本机已装 LibreOffice 时才给出提示'

/** The per-platform install command, for the refusal message (never executed). */
export function libreOfficeHint(): string {
  return '要读旧版格式请自行安装 LibreOffice（Linux `sudo apt install libreoffice`；macOS `brew install --cask libreoffice`；'
    + 'Windows 从 https://www.libreoffice.org/download 安装），并把它放到 PATH 上（或用 AVANTF_SOFFICE 指定）'
}

/** The detected `soffice`, or `undefined`. Never installs, never downloads. */
export function detectLibreOffice(): string | undefined {
  const configured = process.env['AVANTF_SOFFICE']
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return findOnPath(LIBREOFFICE_BINARY)
}
