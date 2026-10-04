import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../src/runtime.js'
import { isPreFingerprintSpace, vectorSpaceId, VECTOR_SPACE_FORMAT_PREFIX } from '../src/db/vectors.js'
import {
  representationKey,
  representationKeyOf,
  UNDECLARED_REPRESENTATION,
  type SemanticBackend,
  type SemanticRepresentation,
} from '@avantf/mem-retrieval'

/**
 * The space id is the REPRESENTATION fingerprint: changing anything that decides which coordinates
 * a persisted vector lives in must change it, or the store keeps serving old vectors as if they
 * were current. Two halves are pinned here:
 *
 *  - the pure id shape (format version + backend/model/dim + representation key), including that a
 *    pre-fingerprint id can never equal a current one;
 *  - detection at the STORE level for EACH knob separately (the cheap `vectorSpaceHealth` pass),
 *    because "the fingerprint string changed" only matters if the store actually reports it stale.
 */
const DIM = 768
const MODEL = 'Xenova/bge-base-zh-v1.5'
const BASE_REP: SemanticRepresentation = { pooling: 'mean', normalize: true, maxInputTokens: 0, revision: 'rev-aaa' }

class RepSemantic implements SemanticBackend {
  readonly name = 'rep_sem'
  readonly dim = DIM
  constructor(private readonly rep: SemanticRepresentation) {}
  isAvailable(): boolean { return true }
  representation(): SemanticRepresentation { return this.rep }
  async encode(): Promise<Float32Array> { const v = new Float32Array(DIM); v[1] = 1; return v }
  async encodeBatch(texts: string[]): Promise<Float32Array[]> { return Promise.all(texts.map(() => this.encode())) }
}

describe('vectorSpaceId (the representation fingerprint shape)', () => {
  it('prefixes the format version and keeps backend/model/dim readable', () => {
    expect(VECTOR_SPACE_FORMAT_PREFIX).toBe('v2/')
    expect(vectorSpaceId('local_bge', MODEL, DIM)).toBe(`v2/local_bge/${MODEL}/768`)
  })

  it('appends the normalized representation key', () => {
    expect(vectorSpaceId('local_bge', MODEL, DIM, representationKey(BASE_REP)))
      .toBe(`v2/local_bge/${MODEL}/768@p=mean;n=1;w=0;r=rev-aaa`)
  })

  it('can never equal a PRE-FINGERPRINT id — the upgrade is a one-time full re-encode', () => {
    const legacy = `local_bge/${MODEL}/768`
    expect(vectorSpaceId('local_bge', MODEL, DIM)).not.toBe(legacy)
    expect(vectorSpaceId('local_bge', MODEL, DIM, representationKey(BASE_REP))).not.toBe(legacy)
    expect(isPreFingerprintSpace(legacy)).toBe(true)
    expect(isPreFingerprintSpace(`v2/local_bge/${MODEL}/768`)).toBe(false)
    // A format this build does not know is also "not current" — and must not be mistaken for one.
    expect(isPreFingerprintSpace(`v3/local_bge/${MODEL}/768`)).toBe(true)
    expect(isPreFingerprintSpace(null)).toBe(false)
  })

  it('names a backend without a declared representation instead of inventing one', () => {
    const bare: SemanticBackend = {
      name: 'custom',
      dim: DIM,
      isAvailable: () => true,
      encode: async () => new Float32Array(DIM),
      encodeBatch: async (t) => t.map(() => new Float32Array(DIM)),
    }
    expect(representationKeyOf(bare)).toBe(UNDECLARED_REPRESENTATION)
    expect(vectorSpaceId('custom', MODEL, DIM, representationKeyOf(bare))).toBe(`v2/custom/${MODEL}/768@${UNDECLARED_REPRESENTATION}`)
  })
})

describe('store detection: every representation knob shows up as stale', () => {
  /** The four deltas the fingerprint must cover, each changing exactly ONE knob. */
  const variants: { name: string; rep: SemanticRepresentation; changed: boolean }[] = [
    { name: 'no change', rep: { ...BASE_REP }, changed: false },
    { name: 'pooling', rep: { ...BASE_REP, pooling: 'cls' }, changed: true },
    { name: 'normalize', rep: { ...BASE_REP, normalize: false }, changed: true },
    { name: 'max_input_tokens', rep: { ...BASE_REP, maxInputTokens: 512 }, changed: true },
    { name: 'model revision', rep: { ...BASE_REP, revision: 'rev-bbb' }, changed: true },
  ]

  for (const { name, rep, changed } of variants) {
    it(`reports ${name === 'no change' ? 'nothing stale' : `a ${name} change as stale`}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avantf-repspace-'))
      // Session 1: persist a small ACTIVE corpus under BASE_REP (the shape being upgraded FROM).
      const before = buildRuntime({ dataHome: dir, semantic: new RepSemantic(BASE_REP) })
      try {
        await before.remember({ action: 'add', content: '第一条基线事实，长度接近真实语料的中位数。' })
        await before.remember({ action: 'add', content: '第二条基线事实，同样接近真实语料的长度分布。' })
      } finally {
        before.shutdown()
      }
      // Session 2: reopen under the variant and ask the cheap detection pass.
      const after = buildRuntime({ dataHome: dir, semantic: new RepSemantic(rep) })
      try {
        expect(after.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: changed ? 2 : 0 })
      } finally {
        after.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('degrades instead of erroring when the revision is unreadable on BOTH sides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-repspace-'))
    const noRevision: SemanticRepresentation = { pooling: 'mean', normalize: true, maxInputTokens: 0 }
    const before = buildRuntime({ dataHome: dir, semantic: new RepSemantic(noRevision) })
    try {
      await before.remember({ action: 'add', content: '没有 revision 的基线事实，指纹只带池化与窗口。' })
    } finally {
      before.shutdown()
    }
    const after = buildRuntime({ dataHome: dir, semantic: new RepSemantic({ ...noRevision }) })
    try {
      // No throw, and no false stale: an unreadable revision is "unknown", not "changed".
      expect(after.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
    } finally {
      after.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
