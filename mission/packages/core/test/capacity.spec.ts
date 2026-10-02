/**
 * Capacity derivation and weight normalization: the pure arithmetic behind the dispatch gate.
 *
 * The derivation chain is tested here rather than through a host, because it is deliberately a pure
 * function of three optional readings — which is also what makes the engine's gate deterministic
 * under injection.
 */
import { describe, expect, it } from 'vitest'
import {
  CAPACITY_CEILING,
  CAPACITY_FALLBACK_PARALLELISM,
  DEFAULT_WEIGHT,
  MAX_WEIGHT,
  MIN_WEIGHT,
  RESERVED_CORES,
  clampCapacity,
  deriveCapacity,
  normalizeWeight,
} from '../src/index.js'

describe('capacity derivation', () => {
  it('prefers an explicit configuration, used as given and with no reserved core', () => {
    const reading = deriveCapacity({ configured: 6, availableParallelism: 12, cores: 12 })
    expect(reading).toEqual({ capacity: 6, source: 'config', parallelism: 6, reserved: 0 })
  })

  it('reads the three derived sources in priority order', () => {
    expect(deriveCapacity({ availableParallelism: 12, cores: 12 }).source).toBe('availableParallelism')
    expect(deriveCapacity({ availableParallelism: 12, cores: 12 }).capacity).toBe(11)
    // `availableParallelism` absent (an older runtime) → the core count.
    expect(deriveCapacity({ cores: 8 })).toEqual({
      capacity: 7,
      source: 'cores',
      parallelism: 8,
      reserved: RESERVED_CORES,
    })
    // Nothing readable → the documented fallback of 4, minus the reserved core.
    expect(deriveCapacity({})).toEqual({
      capacity: CAPACITY_FALLBACK_PARALLELISM - 1,
      source: 'default',
      parallelism: CAPACITY_FALLBACK_PARALLELISM,
      reserved: RESERVED_CORES,
    })
  })

  it('clamps both ends, and degrades dirty readings to the next source', () => {
    expect(deriveCapacity({ configured: 1000 }).capacity).toBe(CAPACITY_CEILING)
    // A fractional configuration floors, then the clamp keeps it at least 1.
    expect(deriveCapacity({ configured: 1.9 }).capacity).toBe(1)
    // A non-numeric/dirty reading is "no reading", never a NaN capacity.
    expect(deriveCapacity({ availableParallelism: Number.NaN, cores: 4 }).source).toBe('cores')
    expect(deriveCapacity({ availableParallelism: 0, cores: 0 }).source).toBe('default')
    // A sub-1 configuration is not a usable reading either: it falls through to the source chain.
    expect(deriveCapacity({ configured: 0, availableParallelism: 9 }).source).toBe('availableParallelism')
    // One core (a heavily constrained container): reserving one cannot reach zero.
    expect(deriveCapacity({ availableParallelism: 1 }).capacity).toBe(1)
    expect(clampCapacity(Number.NaN)).toBe(1)
  })

  it('is deterministic: the same injected readings give the same capacity', () => {
    for (let index = 0; index < 5; index += 1) {
      expect(deriveCapacity({ availableParallelism: 7, cores: 99 }).capacity).toBe(6)
    }
  })
})

describe('weight normalization', () => {
  it('defaults a missing or dirty value to 1', () => {
    expect(normalizeWeight(undefined)).toBe(DEFAULT_WEIGHT)
    expect(normalizeWeight(null)).toBe(DEFAULT_WEIGHT)
    expect(normalizeWeight('4')).toBe(DEFAULT_WEIGHT)
    expect(normalizeWeight(Number.NaN)).toBe(DEFAULT_WEIGHT)
    expect(normalizeWeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WEIGHT)
  })

  it('floors to an integer and clamps into [1, MAX_WEIGHT]', () => {
    expect(normalizeWeight(3.7)).toBe(3)
    expect(normalizeWeight(0)).toBe(MIN_WEIGHT)
    expect(normalizeWeight(-9)).toBe(MIN_WEIGHT)
    expect(normalizeWeight(9_999)).toBe(MAX_WEIGHT)
  })
})
