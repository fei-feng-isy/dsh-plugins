/**
 * Opening a document in the user's editor, platform by platform.
 *
 * Only the pure part is tested here — what file names a command can have on PATH — because the
 * launch itself spawns a real editor. It is the part that SILENTLY degrades: probing only the bare
 * `code` on Windows (where the shim is `code.cmd`) simply loses the editor and falls back to the OS
 * default application, with nothing in the UI to explain why.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { commandFileNames } from '../src/open.js'

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
