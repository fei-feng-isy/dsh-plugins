/**
 * That the gate's VERSION comparison actually fires — the one check the mount smoke cannot reach.
 *
 * The smoke proves the gate runs and reports ok, but its `declared` and `runtime` halves both come from
 * the same baked link set, so they always agree: it can never show that a disagreement is noticed. This
 * test supplies the disagreement and drives the REAL `@avantf/dsh-plugin-base` through this plugin's
 * `provision()` adapter, so the assertion covers the adapter and the base's rule together.
 *
 * What a disagreement produces is a WARNING, not a refusal (`load` stays true): the build's own links
 * moving under it is worth saying out loud and is not by itself proof that the host is incompatible.
 * Pinning that distinction here is the point — "the gate catches version drift" is only true in the
 * sense this test states, and a future change to either direction gets caught.
 */
import * as base from '@avantf/dsh-plugin-base'
import { describe, expect, it } from 'vitest'
import { provision, type CompatRuntime } from '../src/envinit.js'

/** Collect every line the base logs, so the verdict and the log can both be checked. */
function recordingLog() {
  const lines: string[] = []
  return {
    lines,
    log: {
      info: (message: string) => { lines.push(message) },
      warn: (message: string) => { lines.push(message) },
      error: (message: string) => { lines.push(message) },
    },
  }
}

/** A gate runtime whose only interesting field is the spec under test. */
function runtime(spec: CompatRuntime['spec']): CompatRuntime {
  return {
    module: base as unknown as CompatRuntime['module'],
    // The real base module is also the kit; `provision` never reads it, but the runtime type carries it.
    kit: base as unknown as CompatRuntime['kit'],
    prefix: base.COMPAT_PREFIX,
    spec,
    schemaNames: [],
  }
}

describe('the compatibility gate: version drift', () => {
  it('warns when this build was compiled against a version its links no longer resolve', () => {
    const { log, lines } = recordingLog()
    const verdict = provision({ get: () => undefined }, log, runtime({
      packageId: '@avantf/dsh-work',
      // No services declared, so the only finding under test is the version one.
      services: [],
      declared: { '@deepseek-ai/dsh-tools': '0.1.5-rc.2' },
      runtime: { '@deepseek-ai/dsh-tools': '9.9.9' },
    }))

    expect(verdict.warnings.join('\n')).toContain('this build was compiled against @deepseek-ai/dsh-tools 0.1.5-rc.2')
    expect(verdict.warnings.join('\n')).toContain('9.9.9')
    expect(lines.join('\n')).toContain('0.1.5-rc.2')
    // Advisory, not a refusal: `load` is decided by the problem list alone.
    expect(verdict.load).toBe(true)
    expect(verdict.problems).toEqual([])
  })

  it('says nothing about a version when the two sides agree', () => {
    const { log } = recordingLog()
    const verdict = provision({ get: () => undefined }, log, runtime({
      packageId: '@avantf/dsh-work',
      services: [],
      declared: { '@deepseek-ai/dsh-tools': '0.1.5-rc.2' },
      runtime: { '@deepseek-ai/dsh-tools': '0.1.5-rc.2' },
    }))

    expect(verdict.warnings).toEqual([])
    expect(verdict.load).toBe(true)
  })
})
