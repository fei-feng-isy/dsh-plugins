/**
 * The rules: which evidence refuses a load, which merely warns.
 *
 * Pure by construction — `verdictOf` takes plain data, so every branch is reachable here, including
 * the ones a live host cannot be made to produce.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPAT_PREFIX,
  floorOf,
  verdictOf,
  type CompatEvidence,
  type CompatVerdict,
} from '../src/index.js'

/** Healthy evidence: every required service present, both registries probed, versions equal. */
function healthy(overrides: Partial<CompatEvidence> = {}): CompatEvidence {
  return {
    services: [
      { name: 'tools', required: true, present: true, missing: [] },
      { name: 'agents', required: true, present: true, missing: [] },
      { name: 'typert', required: false, present: true, missing: [] },
    ],
    interval: true,
    needsInterval: true,
    toolsProbe: { ran: true, passed: true, problems: [] },
    typertProbe: { ran: true, passed: true, problems: [] },
    versions: [{ package: '@deepseek-ai/dsh-tools', declared: '0.1.5-rc.2', runtime: '0.1.5-rc.2' }],
    events: ['agent/pre-step'],
    ...overrides,
  }
}

/** The `error` lines of a verdict, for terse assertions. */
function errors(verdict: CompatVerdict): string {
  return verdict.lines.filter((line) => line.level === 'error').map((line) => line.message).join('\n')
}

describe('the rules', () => {
  it('loads a host that matches, and says so in one line', () => {
    const verdict = verdictOf(healthy())
    expect(verdict.load).toBe(true)
    expect(verdict.status).toBe('ok')
    expect(verdict.problems).toEqual([])
    expect(verdict.lines).toHaveLength(1)
    expect(verdict.lines[0]?.message).toContain(`${COMPAT_PREFIX} ok`)
    // The version half is worded as THIS build's links, never as the host: a plugin cannot observe
    // the host's identity, and a checkout host with installed links would make `running` a lie.
    expect(verdict.lines[0]?.message).toContain('dsh links: @deepseek-ai/dsh-tools 0.1.5-rc.2')
    expect(verdict.lines[0]?.message).toContain("versions this build's own links resolve; the host identity is not observed")
    expect(verdict.lines[0]?.message).not.toContain('running ')
  })

  it('refuses a load when a required service is gone', () => {
    const verdict = verdictOf(healthy({
      services: [{ name: 'subagents', required: true, present: false, missing: ['startContinuable'] }],
    }))
    expect(verdict.load).toBe(false)
    expect(verdict.status).toBe('probe-failed')
    expect(errors(verdict)).toContain('required service "subagents" is not mounted')
    expect(verdict.reason).toContain('subagents')
  })

  it('refuses a load when a required method was renamed away', () => {
    const verdict = verdictOf(healthy({
      services: [{ name: 'agents', required: true, present: true, missing: ['get'] }],
    }))
    expect(verdict.load).toBe(false)
    expect(errors(verdict)).toContain('"agents" is mounted but exposes no get')
  })

  it('keeps loading when an OPTIONAL service is absent, and records why', () => {
    const verdict = verdictOf(healthy({
      services: [{ name: 'spillStore', required: false, present: false, missing: ['saveText'] }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.notes.join('\n')).toContain('optional service "spillStore" is not mounted')
    // A note is not a finding: it must not reach the log as a warning on a healthy boot.
    expect(verdict.lines.every((line) => line.level === 'info')).toBe(true)
  })

  it('treats a method missing on an OPTIONAL service as a note, not a break', () => {
    const verdict = verdictOf(healthy({
      services: [{ name: 'typert', required: false, present: true, missing: ['get', 'list'] }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.notes.join('\n')).toContain('"typert" is mounted but exposes no get, list')
  })

  it('refuses a load when the timer it needs is gone, and ignores the timer when it does not', () => {
    expect(verdictOf(healthy({ interval: false })).load).toBe(false)
    expect(verdictOf(healthy({ interval: false, needsInterval: false })).load).toBe(true)
  })

  it('refuses a load when either registry rejects the declaration we use', () => {
    const tools = verdictOf(healthy({ toolsProbe: { ran: true, passed: false, problems: ['register() refused a probe declaration'] } }))
    expect(tools.load).toBe(false)
    expect(errors(tools)).toContain('register() refused a probe declaration')

    const typert = verdictOf(healthy({ typertProbe: { ran: true, passed: false, problems: ['toJSONSchema threw'] } }))
    expect(typert.load).toBe(false)
    expect(errors(typert)).toContain('toJSONSchema threw')
  })

  it('never refuses over something it could not determine', () => {
    // No query surface on either registry, no resolvable version: "cannot tell" is not
    // "incompatible" — a skip must keep a working plugin loading.
    const verdict = verdictOf(healthy({
      toolsProbe: { ran: false, passed: false, problems: [] },
      typertProbe: { ran: false, passed: false, problems: [] },
      versions: [{ package: '@deepseek-ai/dsh-tools', declared: undefined, runtime: undefined }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.skipped).toBe(true)
    expect(verdict.status).toBe('probe-skipped')
    expect(verdict.notes.length).toBeGreaterThan(0)
  })

  it('warns about a version difference but still loads', () => {
    const verdict = verdictOf(healthy({
      versions: [{ package: '@deepseek-ai/dsh-tools', declared: '0.1.5-rc.2', runtime: '0.1.6-alpha.2' }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.status).toBe('version-mismatch')
    // The wording pins BOTH halves to this build: the version it was compiled against, and what its
    // links resolve now — plus the one fix. "the running dsh provides" was the misleading phrasing.
    expect(verdict.warnings.join('\n')).toContain(
      'this build was compiled against @deepseek-ai/dsh-tools 0.1.5-rc.2, but its links now resolve to 0.1.6-alpha.2',
    )
    expect(verdict.warnings.join('\n')).toContain('rebuild against this machine\'s dsh (`pnpm build:dsh`)')
    expect(verdict.warnings.join('\n')).not.toContain('running dsh provides')
    expect(verdict.lines.some((line) => line.level === 'warn')).toBe(true)
  })

  it('reports an unresolvable version as unknown in the ok line, never as a warning', () => {
    const verdict = verdictOf(healthy({
      versions: [{ package: '@deepseek-ai/dsh-typert-protocol', declared: '0.1.5-rc.2', runtime: undefined }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.status).toBe('version-unknown')
    expect(verdict.warnings).toEqual([])
    expect(verdict.notes.join('\n')).toContain("this build's links resolve no @deepseek-ai/dsh-typert-protocol")
    expect(verdict.notes.join('\n')).toContain('compiled against 0.1.5-rc.2')
    expect(verdict.lines[0]?.message).toContain('@deepseek-ai/dsh-typert-protocol unknown (compiled against 0.1.5-rc.2)')
  })

  it('says "no version recorded" without blaming a host it cannot see', () => {
    const verdict = verdictOf(healthy({
      versions: [{ package: '@deepseek-ai/dsh-tools', declared: undefined, runtime: '0.1.5-rc.2' }],
    }))
    expect(verdict.load).toBe(true)
    expect(verdict.status).toBe('version-unknown')
    expect(verdict.notes.join('\n')).toContain('this build records no version for @deepseek-ai/dsh-tools')
    expect(verdict.notes.join('\n')).not.toContain('running dsh')
  })

  it('reports event names as an unprovable limit, never as a finding', () => {
    const verdict = verdictOf(healthy({ events: ['agent/pre-step', 'subagent/end'] }))
    expect(verdict.load).toBe(true)
    expect(verdict.notes.join('\n')).toContain('agent/pre-step')
    expect(verdict.warnings).toEqual([])
  })

  it('says nothing about events when the caller declared none', () => {
    expect(verdictOf(healthy({ events: [] })).notes.join('\n')).not.toContain('event names')
  })

  it('reads the version a build declares out of a peer range', () => {
    expect(floorOf('^0.1.5-rc.2')).toBe('0.1.5-rc.2')
    expect(floorOf('~4.6.5')).toBe('4.6.5')
    expect(floorOf('>=1.2.3')).toBe('1.2.3')
    expect(floorOf('workspace:*')).toBeUndefined()
    expect(floorOf(undefined)).toBeUndefined()
  })

  it('reads the floor of a COMPOUND range instead of giving up on it', () => {
    // An explicit upper bound is the everyday form — this package's own zod peer is `>=4.4.3 <5`.
    // Reading the first comparator is what makes the floor survive it; returning `undefined` here
    // would silently downgrade the declared side to "unknown" for a perfectly readable range.
    expect(floorOf('>=4.4.3 <5')).toBe('4.4.3')
    expect(floorOf('>=4.4.3<5')).toBe('4.4.3')
    expect(floorOf('>=0.1.5-rc.2 <0.2.0')).toBe('0.1.5-rc.2')
    expect(floorOf('>= 1.2.3 < 2')).toBe('1.2.3')
    expect(floorOf('^0.1.5-rc.2 || ^0.2.0')).toBe('0.1.5-rc.2')
    expect(floorOf('v1.2.3')).toBe('1.2.3')
    // A range that starts with an UPPER bound names no floor: answering 2.0.0 would be a lie.
    expect(floorOf('<2.0.0')).toBeUndefined()
    expect(floorOf('<=2.0.0')).toBeUndefined()
    expect(floorOf('*')).toBeUndefined()
  })
})
