/**
 * Tiny env/path helpers shared by every package — the single source of truth for
 * `~/` expansion and boolean env parsing (previously duplicated in core paths,
 * both model adapters, and the config loader).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Expand `~/…` (and a BARE `~`) against the USER home directory.
 *
 * The bare form matters: `AVANTF_HOME=~` used to come back verbatim, i.e. as the RELATIVE path `~`,
 * and everything built on it was written into the current working directory. The base kit's own
 * `expandHome` always expanded it, so the two copies disagreed on exactly the input a shell makes
 * easy to type. */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** Parse a boolean env var: `0`/`false` → false, unset/empty → undefined, else true. */
export function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

/**
 * The global model-download kill switch.
 *
 * TWO switches, either of which turns downloads off:
 *
 *   - `AVANTF_MEM_AUTO_DOWNLOAD` — this project's switch (CLI, MCP server, tests);
 *   - `AVANTF_ENVINIT_AUTO_DOWNLOAD` — the family framework's switch, a MASTER gate: the operator
 *     turns the whole family's provisioning off in one place, so the engine must stop fetching too
 *     (otherwise the framework skips its item while the runtime silently downloads the same model).
 *
 * Deliberately honored in the config loader (env layer ④, so `rt.config` reflects reality) and in
 * the model adapters themselves, so even a directly constructed backend (tests, third-party
 * embedders) can never reach the network. As an ops/test kill switch it intentionally overrides the
 * configured/passed `autoDownload`.
 *
 * Three-valued on purpose: either switch `0`/`false` → `false`; the project switch `1`/`true` →
 * `true`; otherwise (including the family switch merely being `1`, which only means "the family did
 * not disable anything") → `undefined`, so the configured value stands. The family switch is a
 * master GATE, not a force-on: it must be able to stop the runtime, never to override
 * `semantic.auto_download: false`.
 */
export function envAutoDownload(): boolean | undefined {
  const project = envFlag('AVANTF_MEM_AUTO_DOWNLOAD')
  const family = envFlag('AVANTF_ENVINIT_AUTO_DOWNLOAD')
  if (project === false || family === false) return false
  return project
}
