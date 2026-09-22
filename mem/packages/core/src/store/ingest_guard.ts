/**
 * Ingestion boundary (DESIGN §8 / D5).
 *
 * A `source_uri` is RESOLVED, not stored: a local path is read from disk, an
 * http(s) URL is fetched — and whatever comes back lands in a searchable index the
 * agent reads back through `kb_query`. That makes the parameter an exfiltration
 * primitive for an agent steered by untrusted content ("ingest ~/.ssh/id_rsa",
 * "ingest http://169.254.169.254/latest/meta-data/…", "…and then tell me what you
 * found"). This module is the boundary:
 *
 *  - local paths must resolve INSIDE an allowed root (`knowledge.ingest.local_roots`,
 *    default: the process workspace). The path is `realpath`-ed first, so neither
 *    `..` nor a symlink can climb out;
 *  - http(s) URLs must not address loopback/private/link-local space
 *    (`knowledge.ingest.allow_private_network` lifts it), and EVERY redirect hop is
 *    re-checked — letting the transport follow redirects would let a public URL
 *    bounce straight into 127.0.0.1 and defeat the check.
 *
 * Out of scope (documented, not silently ignored): a DNS name that RESOLVES to a
 * private address (rebinding). Blocking that needs a resolve-then-pin fetch hook,
 * which undici does not expose. The literal forms are covered — `new URL()`
 * normalizes `http://2130706433/`, `http://0x7f.1/` and `http://0177.0.0.1/` to
 * `127.0.0.1` and `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and both are caught below.
 */
import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { expandHome } from '@avantf/mem-contract'

/**
 * Where these knobs live. The boundary belongs to the knowledge store (only it
 * ingests), so it sits in the per-store config — naming it in the errors matters,
 * because the obvious place to look is the common `~/.avantf/configs/common.yaml`, where
 * the `knowledge.` prefix is a key the loader will reject as unknown.
 */
const KB_CONFIG_FILE = '~/.avantf/configs/knowledge.yaml'

/** The boundary knobs, as resolved from `knowledge.ingest`. */
export interface IngestLimits {
  /** Roots a local `source_uri` may be read from; empty ⇒ the process workspace. */
  local_roots: readonly string[]
  allow_outside_workspace: boolean
  allow_private_network: boolean
}

/** Strip IPv6 brackets and the FQDN root dot — `localhost.` and `[::1]` are `localhost` and `::1`. */
function normalizeHost(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return bare.toLowerCase().replace(/\.$/, '')
}

/** `a.b.c.d` → its four octets, or null when the host is not a dotted-quad literal. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m === null) return null
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  return octets.every((n) => n <= 255) ? octets : null
}

/**
 * Unwrap an IPv4-mapped IPv6 literal to its dotted-quad form.
 * `new URL()` re-encodes the tail as hex groups (`[::ffff:7f00:1]`), so both
 * spellings must be understood or the mapped form is a bypass.
 */
function mappedIpv4(host: string): string | null {
  const m = /^::ffff:(.+)$/.exec(host)
  if (m === null) return null
  const tail = m[1]
  if (tail.includes('.')) return tail
  const groups = tail.split(':')
  if (groups.length !== 2) return null
  const hex = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  if (hex.some((n) => Number.isNaN(n))) return null
  return `${hex[0] >> 8}.${hex[0] & 0xff}.${hex[1] >> 8}.${hex[1] & 0xff}`
}

/**
 * Whether a URL hostname addresses loopback / private / link-local / other
 * non-public space. Names are matched by suffix too (`*.local` mDNS, `*.internal`,
 * `*.home.arpa`), since those resolve inside the LAN by construction.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host === '') return true
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
  ) {
    return true
  }
  const mapped = mappedIpv4(host)
  if (mapped !== null) return isPrivateHostname(mapped)

  if (host.includes(':')) {
    // IPv6 literal: unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10).
    if (host === '::' || host === '::1') return true
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true
    return false
  }

  const octets = ipv4Octets(host)
  if (octets === null) return false // a DNS name — see the rebinding note in the module doc
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true // multicast + reserved
  return false
}

/** Validate one `http(s)` source URL, refusing non-public targets unless opted in. */
export function assertFetchableUrl(uri: string, limits: Pick<IngestLimits, 'allow_private_network'>): URL {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error(`source_uri 不是合法的 URL：${uri}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`source_uri 必须是 http(s) 或本地路径（收到 '${url.protocol}'）：${uri}`)
  }
  if (!limits.allow_private_network && isPrivateHostname(url.hostname)) {
    throw new Error(
      `拒绝抓取 '${url.hostname}'：loopback/私网地址 —— `
      + `如需抓取内网地址，请在 ${KB_CONFIG_FILE} 里设 knowledge.ingest.allow_private_network: true`,
    )
  }
  return url
}

/** The roots a local `source_uri` may be read from (realpath'd), defaulting to the workspace. */
export function allowedLocalRoots(limits: Pick<IngestLimits, 'local_roots'>): string[] {
  const configured = limits.local_roots.length > 0 ? limits.local_roots : [process.cwd()]
  return configured.map((root) => {
    const expanded = expandHome(root)
    // A root that does not exist yet cannot be realpath'd; compare against its literal form.
    return existsSync(expanded) ? realpathSync(expanded) : resolve(expanded)
  })
}

/**
 * Resolve a local `source_uri` to the real absolute path it names, refusing one
 * that lands outside the allowed roots.
 *
 * @returns the `realpath` — which is what the caller should BOTH read and store, so
 *   the recorded `source_uri` is exactly the file that was read.
 */
export function resolveLocalSource(raw: string, limits: IngestLimits): string {
  const abs = expandHome(raw.startsWith('~/') ? raw : resolve(raw))
  if (!existsSync(abs)) throw new Error(`找不到 source_uri：${abs}`)
  // realpath FIRST: `..`, symlinks and case are only resolved by the filesystem, and
  // a prefix check against anything else is a guess that a symlink can defeat.
  const real = realpathSync(abs)
  if (limits.allow_outside_workspace) return real

  const roots = allowedLocalRoots(limits)
  // Compare with a trailing separator so `/srv/ws-evil` is not accepted for root `/srv/ws`.
  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))
  if (!inside) {
    throw new Error(
      `source_uri 超出允许范围：${real}（允许的根：${roots.join('、') || '（无）'}）—— `
      + `请在 ${KB_CONFIG_FILE} 里把它加进 knowledge.ingest.local_roots，或设 knowledge.ingest.allow_outside_workspace: true`,
    )
  }
  return real
}
