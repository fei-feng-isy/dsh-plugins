/**
 * Two **processes** installing the same item into one `home` must publish exactly
 * once. The child harness (which is plain JavaScript, so it can import the built package) counts the
 * renames that land in the resource root; the downloads may happen twice, the publish may not.
 *
 * @module test/two-process
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { integrityOf, packageTarball } from './helpers/registry.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js')
const CHILD = join(REPO_ROOT, 'test', 'helpers', 'publish-child.mjs')

function runChild(home: string, tarballPath: string, integrity: string, startPath: string): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CHILD, pathToFileURL(DIST_ENTRY).href, home, tarballPath, integrity, startPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('两个进程同时首次安装同一项（并发）', () => {
  let root: string
  let home: string
  let tarballPath: string
  let startPath: string
  let integrity: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-two-process-'))
    home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const tarball = packageTarball()
    integrity = integrityOf(tarball)
    tarballPath = join(root, 'demo-pkg.tgz')
    await writeFile(tarballPath, tarball)
    startPath = join(root, 'start')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('只发布一次，两个进程都成功', async () => {
    const first = runChild(home, tarballPath, integrity, startPath)
    const second = runChild(home, tarballPath, integrity, startPath)
    // Release both at once; writing the file is the starting gun.
    writeFileSync(startPath, 'go')
    const [a, b] = await Promise.all([first, second])

    expect(a.code, a.stderr).toBe(0)
    expect(b.code, b.stderr).toBe(0)
    const reportA = JSON.parse(a.stdout) as { renamed: number; actions: readonly string[] }
    const reportB = JSON.parse(b.stdout) as { renamed: number; actions: readonly string[] }
    expect(reportA.actions.every(action => action === 'installed' || action === 'present')).toBe(true)
    expect(reportB.actions.every(action => action === 'installed' || action === 'present')).toBe(true)
    // Both may download; exactly one rename may land in the resource root.
    expect(reportA.renamed + reportB.renamed).toBe(1)

    const installed = JSON.parse(readFileSync(join(home, 'runtime', 'demo-pkg', '1.0.0', 'install.json'), 'utf8')) as { name: string; version: string }
    expect(installed).toMatchObject({ name: 'demo-pkg', version: '1.0.0' })
    // The loser's staging directory is gone, and no quarantine was needed.
    const listing = (path: string): readonly string[] => (existsSync(path) ? readdirSync(path) : [])
    expect(listing(join(home, '.envinit', '.tmp'))).toEqual([])
    expect(listing(join(home, '.envinit', '.quarantine'))).toEqual([])
  }, 60_000)
})
