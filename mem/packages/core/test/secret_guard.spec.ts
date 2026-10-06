import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { detectSecretShape, secretRefusalMessage } from '../src/store/secret_guard.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/**
 * P-03 — the write-side secret/PII guard.
 *
 * The ONLY real risk of this feature is a FALSE POSITIVE (a legitimate note refused), so the
 * counterexample set is the load-bearing half: every shape below is something an operator or a
 * README legitimately writes down, and every one of them must pass through untouched.
 *
 * On "本仓的 .env.example / README 示例 token": this repository has NO `.env.example` and its
 * READMEs carry no credential-shaped examples (verified: `find . -name .env.example` is empty and
 * `grep -E 'sk-|ghp_|AKIA|xox'` over `*.md` only hits the word `npm_config_prefix`). The
 * counterexamples therefore use the canonical documented placeholders every `.env.example` in this
 * space carries — AWS's `AKIAIOSFODNN7EXAMPLE`, the masked `xxxx…` forms, Stripe's public
 * `sk_test_…` sandbox key, the documented 身份证, the documented test PAN, and a
 * `postgres://user:password@host` connection string — plus this repo's own documentation strings.
 */
class NeverWarm implements SemanticBackend {
  readonly name = 'secret_guard_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

/** Positive examples: one per high-confidence shape. */
const POSITIVES: readonly { kind: string; text: string }[] = [
  { kind: 'provider-key', text: 'OpenAI 的 key 是 sk-proj-9fK2mQ7xLpZ4vN8rT1bW6yH3' },
  { kind: 'provider-key', text: '用 ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 拉代码' },
  { kind: 'provider-key', text: 'AWS key: AKIA3XQZ7Y2M4N6P8R0T' },
  { kind: 'provider-key', text: 'npm token npm_9dK2mQ7xLpZ4vN8rT1bW6yH3aC5eG7j0K1l2' },
  { kind: 'private-key', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x9fK2mQ\n-----END RSA PRIVATE KEY-----' },
  { kind: 'connection-string', text: '数据库是 postgres://admin:S3cr3t-P4ss@db.internal:5432/app' },
  { kind: 'card-number', text: '卡号 4532015112830366 用于对账' },
  { kind: 'national-id', text: '身份证 320102199001014564' },
]

/** Counterexamples: documented placeholders and ordinary prose. NONE may be refused. */
const COUNTEREXAMPLES: readonly string[] = [
  // canonical, documented placeholders (.env.example / provider docs)
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  'OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'Stripe 测试密钥形如 sk_test_4eC39HqLyjWDarjtT1zdp7dc，只在沙箱可用',
  'POSTGRES_URL=postgres://user:password@localhost:5432/app',
  'DATABASE_URL=mysql://root:${MYSQL_PASSWORD}@127.0.0.1:3306/db',
  'redis://default:changeme@cache:6379/0',
  '测试卡号 4111 1111 1111 1111 只用于沙箱',
  '文档示例身份证 11010519491231002X 不是真实证件',
  // this repository's own documentation strings (paths, model names, config keys)
  '数据根是 ~/.avantf，库在 ~/.avantf/memory/memory.db',
  '默认模型是 Xenova/bge-base-zh-v1.5（768 维）',
  'API key 的存放位置在 1Password 的 avantf 条目里，不写明文',
  '在 configs/common.yaml 里设置 semantic.auto_migrate: false',
  'npm_config_prefix 指向假的全局根',
  // near-misses that must stay out of scope
  'sk- 是一个常见前缀',
  '订单号 1234567890123456 与卡号无关',
]

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-secret-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('P-03 secret guard (pure shape detection)', () => {
  it('catches every high-confidence positive example', () => {
    for (const { kind, text } of POSITIVES) {
      const hit = detectSecretShape(text)
      expect(hit, `must be refused: ${text}`).not.toBeNull()
      expect(hit?.kind, `kind of: ${text}`).toBe(kind)
      // The message is the remedy, and it must never echo the secret itself.
      const message = secretRefusalMessage(hit!)
      expect(message).toContain('存放位置')
      expect(message).not.toContain(text)
    }
  })

  it('does not refuse any documented placeholder or ordinary prose (zero false positives)', () => {
    for (const text of COUNTEREXAMPLES) {
      expect(detectSecretShape(text), `must NOT be refused: ${text}`).toBeNull()
    }
  })

  it('is deterministic and non-mutating', () => {
    const text = POSITIVES[0].text
    expect(detectSecretShape(text)).toEqual(detectSecretShape(text))
    expect(text).toBe(POSITIVES[0].text)
    expect(detectSecretShape('')).toBeNull()
  })
})

describe('P-03 secret guard (write path)', () => {
  it('refuses add with an actionable error and stores nothing', async () => {
    await expect(rt.remember({ action: 'add', content: POSITIVES[0].text }))
      .rejects.toThrow(/存放位置或获取方式/)
    const stats = rt.admin({ action: 'stats' })
    expect(stats.active, 'the refused fact must not be persisted').toBe(0)
  })

  it('refuses update too — a rewrite is not a bypass', async () => {
    const { fact_id } = await rt.remember({ action: 'add', content: '数据库连接串存放在 1Password 的 db 条目' })
    await expect(rt.remember({ action: 'update', fact_id, content: POSITIVES[5].text }))
      .rejects.toThrow(/存放位置或获取方式/)
    // The original row is untouched.
    const detail = rt.admin({ action: 'detail', fact_id })
    expect(detail !== null && 'content' in detail ? detail.content : undefined).toBe('数据库连接串存放在 1Password 的 db 条目')
  })

  it('leaves ordinary facts writable', async () => {
    const { fact_id } = await rt.remember({ action: 'add', content: COUNTEREXAMPLES[11] })
    expect(fact_id).toBeGreaterThan(0)
    expect(rt.admin({ action: 'stats' }).active).toBe(1)
  })
})
