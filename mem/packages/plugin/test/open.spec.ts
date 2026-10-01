/**
 * Opening a document in the user's editor, platform by platform.
 *
 * Two things are asserted here, and both are the parts that SILENTLY degrade:
 *
 * 1. What file names a command can have on PATH — probing only the bare `code` on Windows (where the
 *    shim is `code.cmd`) simply loses the editor and falls back to the OS default application.
 * 2. What `spawn` receives, and what happens when it refuses. Since CVE-2024-27980 Node throws
 *    EINVAL for a `.cmd`/`.bat` spawned without a shell, and the old empty `catch` swallowed it:
 *    "prefer VS Code" quietly became `cmd /c start`. The win32 shape is asserted by injecting the
 *    platform (Linux can then check it), and the two failure paths by injecting `spawn`/`warn`.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  classifyLaunchFailure, commandFileNames, isWindowsBatchShim, launchPlan, openDocumentPath,
  resolveOnPath, type LaunchOptions, type SpawnLike,
} from '../src/open.js'

const original = process.env['PATHEXT']
afterEach(() => {
  if (original === undefined) delete process.env['PATHEXT']
  else process.env['PATHEXT'] = original
})

describe('commandFileNames', () => {
  it('probes the bare name on POSIX', () => {
    expect(commandFileNames('code', 'linux')).toEqual(['code'])
    expect(commandFileNames('code', 'darwin')).toEqual(['code'])
  })

  it('probes the executable extensions on Windows (a shim is code.cmd, never code)', () => {
    const names = commandFileNames('code', 'win32')
    expect(names).toContain('code')
    expect(names).toContain('code.cmd')
    expect(names).toContain('code.exe')
    expect(names).toContain('code.bat')
  })

  it('honours PATHEXT when the shell exports one', () => {
    process.env['PATHEXT'] = '.EXE;.CMD'
    const names = commandFileNames('cursor', 'win32')
    expect(names).toContain('cursor.cmd')
    expect(names).not.toContain('cursor.bat') // not in this PATHEXT
  })
})

describe('resolveOnPath', () => {
  it('returns the file NAME, so a win32 `code` resolves to `code.cmd`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-path-'))
    try {
      writeFileSync(join(dir, 'code.cmd'), '')
      chmodSync(join(dir, 'code.cmd'), 0o755)
      // The extension-less `code` is NOT installed: only the `.cmd` shim is, exactly as on Windows.
      expect(resolveOnPath('code', 'win32', { PATH: dir, PATHEXT: '.EXE;.CMD' })).toBe('code.cmd')
      expect(resolveOnPath('code', 'linux', { PATH: dir })).toBeUndefined()
      expect(resolveOnPath('code', 'win32', { PATH: '', PATHEXT: '.CMD' })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('launchPlan — the Windows shell rule (CVE-2024-27980)', () => {
  it('spawns a .cmd/.bat shim through a shell on win32, and directly on POSIX', () => {
    const win = launchPlan('C:\\Users\\u\\bin\\code.cmd', 'C:\\docs\\a.md', 'win32')
    expect(win.command).toBe('C:\\Users\\u\\bin\\code.cmd')
    expect(win.args).toEqual(['C:\\docs\\a.md'])
    expect(win.options).toEqual({ detached: true, stdio: 'ignore', shell: true })

    // The SAME command name on POSIX (a shell script called `code.cmd` — contrived, but it pins the
    // rule to the platform) must not silently get a shell.
    const posix = launchPlan('code.cmd', '/docs/a.md', 'linux')
    expect(posix.options).toEqual({ detached: true, stdio: 'ignore' })
    expect(posix.options.shell).toBeUndefined()
  })

  it('quotes a spaced shim path and a spaced argument for the cmd.exe line', () => {
    const plan = launchPlan('C:\\Program Files\\VS Code\\bin\\code.cmd', 'C:\\My Docs\\a.md', 'win32')
    expect(plan.command).toBe('"C:\\Program Files\\VS Code\\bin\\code.cmd"')
    expect(plan.args).toEqual(['"C:\\My Docs\\a.md"'])
  })

  it('keeps the cmd /c start fallback with its title argument', () => {
    const plan = launchPlan('cmd', 'C:\\docs\\a.md', 'win32')
    expect(plan.command).toBe('cmd')
    expect(plan.args).toEqual(['/c', 'start', '', '"C:\\docs\\a.md"'])
    expect(plan.options.shell).toBeUndefined()
  })

  it('recognises batch shims by extension, case-insensitively, on win32 only', () => {
    expect(isWindowsBatchShim('code.cmd', 'win32')).toBe(true)
    expect(isWindowsBatchShim('code.BAT', 'win32')).toBe(true)
    expect(isWindowsBatchShim('code.exe', 'win32')).toBe(false)
    expect(isWindowsBatchShim('code', 'win32')).toBe(false)
    expect(isWindowsBatchShim('code.cmd', 'linux')).toBe(false)
  })
})

describe('classifyLaunchFailure', () => {
  it('reads ENOENT as "editor missing" and everything else as "launch refused"', () => {
    expect(classifyLaunchFailure(Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' }))).toBe('missing')
    expect(classifyLaunchFailure(Object.assign(new Error('spawn code EINVAL'), { code: 'EINVAL' }))).toBe('refused')
    expect(classifyLaunchFailure(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe('refused')
    expect(classifyLaunchFailure(new Error('no code at all'))).toBe('refused')
  })
})

/** A fake `spawn` that records its calls and applies `behaviour` to the Nth one. */
function fakeSpawn(behaviour: (call: number) => void = () => {}) {
  const calls: { command: string; args: string[]; options: LaunchOptions }[] = []
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options })
    behaviour(calls.length)
    return { unref: () => {} }
  }
  return { calls, spawn }
}

describe('openDocumentPath — the two failure paths', () => {
  it('WARNS when a launch is refused, then still tries the next candidate', () => {
    const warnings: string[] = []
    const { calls, spawn } = fakeSpawn((call) => {
      // The EINVAL a `.cmd` gets without a shell after CVE-2024-27980.
      if (call === 1) throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
    })
    const outcome = openDocumentPath('/docs/a.md', 'file', process.execPath, {
      platform: 'linux',
      // No `code`/`xdg-open` on this PATH; `$VISUAL` is the second candidate.
      env: { PATH: '', VISUAL: process.execPath },
      spawn,
      warn: (message) => { warnings.push(message) },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[1]?.command).toBe(process.execPath)
    expect(outcome).toEqual({ path: '/docs/a.md', target: 'file', opener: process.execPath })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('EINVAL')
    expect(warnings[0]).toContain('改用下一个候选')
  })

  it('SKIPS silently when the editor is simply not installed', () => {
    const warnings: string[] = []
    const { calls, spawn } = fakeSpawn()
    const outcome = openDocumentPath('/docs/a.md', 'file', 'no-such-editor-xyz', {
      platform: 'linux',
      env: { PATH: '', VISUAL: process.execPath },
      spawn,
      warn: (message) => { warnings.push(message) },
    })
    // The configured editor was never spawned (it does not exist) and nothing was warned: this is
    // the documented fall-through, not a defect.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(outcome.opener).toBe(process.execPath)
    expect(warnings).toEqual([])
  })

  it('SKIPS silently on a synchronous ENOENT, and reports it as missing when nothing is left', () => {
    const warnings: string[] = []
    const { calls, spawn } = fakeSpawn(() => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    })
    expect(() => openDocumentPath('/docs/a.md', 'file', process.execPath, {
      platform: 'linux', env: { PATH: '' }, spawn, warn: (message) => { warnings.push(message) },
    })).toThrow(/没有可用的编辑器：.*不存在/u)
    expect(calls).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('carries a refused launch into the thrown message (what the UI finally shows)', () => {
    const { spawn } = fakeSpawn(() => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
    })
    expect(() => openDocumentPath('/docs/a.md', 'file', process.execPath, {
      platform: 'linux', env: { PATH: '' }, spawn, warn: () => {},
    })).toThrow(/启动被拒绝：.*EINVAL/u)
  })

  it('names an editor that was searched for but is not there', () => {
    const { spawn } = fakeSpawn()
    expect(() => openDocumentPath('/docs/a.md', 'file', 'ghost-editor', {
      platform: 'linux', env: { PATH: '' }, spawn, warn: () => {},
    })).toThrow(/ghost-editor 不存在/u)
  })

  it('launches the win32 cmd fallback with its title argument', () => {
    const { calls, spawn } = fakeSpawn()
    const outcome = openDocumentPath('C:\\docs\\a.md', 'file', '', {
      platform: 'win32',
      env: { PATH: '', PATHEXT: '.CMD' },
      spawn,
      warn: () => {},
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('cmd')
    expect(calls[0]?.args).toEqual(['/c', 'start', '', '"C:\\docs\\a.md"'])
    expect(outcome).toEqual({ path: 'C:\\docs\\a.md', target: 'file', opener: 'cmd' })
  })

  it('drives a resolved win32 `code.cmd` through a shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-win-'))
    try {
      writeFileSync(join(dir, 'code.cmd'), '')
      chmodSync(join(dir, 'code.cmd'), 0o755)
      const { calls, spawn } = fakeSpawn()
      const outcome = openDocumentPath('C:\\docs\\a.md', 'file', '', {
        platform: 'win32',
        env: { PATH: dir, PATHEXT: '.CMD' },
        spawn,
        warn: () => {},
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe('code.cmd')
      expect(calls[0]?.options.shell).toBe(true)
      expect(outcome.opener).toBe('code.cmd')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
