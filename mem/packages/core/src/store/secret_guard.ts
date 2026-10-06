/**
 * Write-side secret / PII shape guard (P-03) — a PURE function, no store, no IO.
 *
 * The memory store is a long-lived, backed-up, sometimes-remote copy of what the model chose to
 * write down, so a plaintext credential that reaches it is hard to retract. This guard refuses a
 * fact whose TEXT matches a HIGH-CONFIDENCE credential/PII shape. It is deliberately narrow: only
 * shapes that a false positive is unlikely to produce, because a guard that refuses legitimate
 * notes is worse than no guard — the model learns to stop recording.
 *
 * What it does NOT do, by design:
 *  - no rewriting (a silently redacted fact is a lie the caller cannot see);
 *  - no scanning of what is already stored (writes only, never a retroactive sweep);
 *  - no knowledge-base coverage (`kb_add` ingests user-provided documents and is out of scope);
 *  - no config/override path (the refusal carries its own remedy: record WHERE the secret lives).
 *
 * The refusal message is the interface: it names the shape and tells the caller what to write
 * instead. The plugin turns a thrown store error into a tool error through its existing `wireErr`
 * path, so no new field and no new error surface is introduced.
 */

export type SecretKind =
  | 'provider-key'
  | 'private-key'
  | 'connection-string'
  | 'card-number'
  | 'national-id'

export interface SecretShape {
  kind: SecretKind
  /** Human-readable name of the shape, safe to put in an error (never the matched value). */
  label: string
}

/** Words that make a matching string an EXAMPLE rather than a live credential. */
const PLACEHOLDER_WORDS = [
  'your', 'example', 'placeholder', 'changeme', 'replace', 'dummy', 'fake',
  'sample', 'redacted', 'insert', 'paste', 'mykey', 'my-key', 'todo',
] as const

/** A run of the same character this long is a mask (`xxxx…`, `****…`), not key material. */
function hasLongRepeat(value: string): boolean {
  return /(.)\1{7,}/.test(value)
}

function looksPlaceholder(value: string): boolean {
  const lower = value.toLowerCase()
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true
  // `xxxx…`, `sk-aaaa…`, `AIza0000…`: a mask, not a key. A real key essentially never contains a
  // run of eight identical characters, while every documented mask does.
  return hasLongRepeat(lower)
}

/**
 * Provider key prefixes that are specific enough to be a signal on their own.
 *
 * The body length floors matter: `sk-` alone is a prefix anyone may write about. Note the Stripe
 * pattern deliberately matches only `_live_` keys — a `sk_test_…` is a public sandbox value, not a
 * secret, and the canonical documented example must not be refused.
 */
const PROVIDER_KEYS: readonly { label: string; re: RegExp }[] = [
  { label: 'OpenAI/Anthropic 风格的 API key（`sk-`）', re: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}/g },
  { label: 'Stripe live 密钥（`sk_live_`/`rk_live_`）', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { label: 'GitHub token（`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`）', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { label: 'GitHub fine-grained PAT（`github_pat_`）', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: 'Slack token（`xox…`）', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'AWS access key id（`AKIA…`）', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API key（`AIza…`）', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'GitLab PAT（`glpat-`）', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { label: 'npm token（`npm_`）', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
]

/** `-----BEGIN … PRIVATE KEY-----`, any of the common flavours. */
const PRIVATE_KEY_PEM = /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}/

/** `scheme://user:password@host` — a connection string that carries credentials inline. */
const CONNECTION_STRING = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:/@]+):([^\s@/]{3,})@([^\s/]+)/gi

/** Documented example passwords — the canonical `.env.example` / README placeholders. */
const PASSWORD_PLACEHOLDERS = new Set([
  'password', 'pass', 'pwd', 'passwd', 'secret', 'changeme', 'example',
  'your_password', 'yourpassword', 'your-password', 'xxxx', 'xxxxxx', 'xxxxxxxx',
  'token', 'key', 'apikey', 'api_key', 'redacted',
])

function looksPlaceholderPassword(password: string): boolean {
  const lower = password.toLowerCase()
  if (PASSWORD_PLACEHOLDERS.has(lower)) return true
  if (lower.startsWith('<') || lower.startsWith('${')) return true
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true
  return new Set(lower).size <= 1
}

/** Canonical, DOCUMENTED test PANs — a Luhn-valid number that is on this list is not a live card. */
const CARD_EXAMPLES = new Set([
  '4111111111111111', '4012888888881881', '4222222222222',
  '5555555555554444', '5105105105105100', '5200828282828210',
  '378282246310005', '371449635398431', '6011111111111117',
  '3056930009020004', '3566002020360505', '4242424242424242',
  '4000056655665556',
])

/** Canonical documentation 身份证 (checksum-valid, so it would otherwise be refused). */
const NATIONAL_ID_EXAMPLES = new Set(['11010519491231002x'])

/** ISO 7064:1983 MOD 11-2, plus a plausible birth date inside the encoding. */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const ID_CHECK = '10X98765432'

function validNationalId(value: string): boolean {
  const v = value.toUpperCase()
  const year = Number(v.slice(6, 10))
  const month = Number(v.slice(10, 12))
  const day = Number(v.slice(12, 14))
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(v[i]) * ID_WEIGHTS[i]
  return ID_CHECK[sum % 11] === v[17]
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

function detectCard(text: string): SecretShape | null {
  // 13–19 digits, optionally grouped with spaces/dashes (the way cards are written down).
  const re = /(?<![\d])((?:\d[ -]?){12,18}\d)(?![\d])/g
  for (const match of text.matchAll(re)) {
    const digits = match[1].replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) continue
    if (CARD_EXAMPLES.has(digits)) continue
    // Test PANs repeat one or two digits; a real card has a broad digit alphabet.
    if (new Set(digits).size <= 3) continue
    if (luhnValid(digits)) return { kind: 'card-number', label: '银行卡号（Luhn 校验通过）' }
  }
  return null
}

function detectNationalId(text: string): SecretShape | null {
  const re = /(?<![0-9A-Za-z])(\d{17}[0-9Xx])(?![0-9A-Za-z])/g
  for (const match of text.matchAll(re)) {
    const value = match[1]
    if (NATIONAL_ID_EXAMPLES.has(value.toLowerCase())) continue
    if (validNationalId(value)) return { kind: 'national-id', label: '身份证号（校验位通过）' }
  }
  return null
}

/**
 * The guard. Returns the matched SHAPE (never the matched text) or `null`.
 *
 * Order is by specificity: a PEM block or a known prefix is a stronger signal than a bare number,
 * so a fact that carries both is reported as the credential it obviously is.
 */
export function detectSecretShape(text: string): SecretShape | null {
  if (PRIVATE_KEY_PEM.test(text)) {
    return { kind: 'private-key', label: '私钥 PEM 块（`-----BEGIN … PRIVATE KEY-----`）' }
  }

  for (const { label, re } of PROVIDER_KEYS) {
    for (const match of text.matchAll(re)) {
      if (!looksPlaceholder(match[0])) return { kind: 'provider-key', label }
    }
  }

  for (const match of text.matchAll(CONNECTION_STRING)) {
    if (!looksPlaceholderPassword(match[3])) {
      return { kind: 'connection-string', label: `带明文凭据的连接串（\`${match[1]}://…\`）` }
    }
  }

  return detectCard(text) ?? detectNationalId(text)
}

/** The refusal the caller sees — names the shape and says what to write instead. */
export function secretRefusalMessage(shape: SecretShape): string {
  return `检测到疑似${shape.label}，已拒绝写入明文：请改为记录它的存放位置或获取方式（例如「密钥在 1Password 的 xxx 条目」），不要写入凭据本身。`
}
