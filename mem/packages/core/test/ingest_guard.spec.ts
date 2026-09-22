import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { isPrivateHostname, resolveLocalSource, allowedLocalRoots } from '../src/store/ingest_guard.js'
import { allowAnyDomain } from './helpers.js'

const limits = (over: Partial<{ local_roots: string[]; allow_outside_workspace: boolean; allow_private_network: boolean }> = {}) => ({
  local_roots: [],
  allow_outside_workspace: false,
  allow_private_network: false,
  ...over,
})

const OUTSIDE = limits({ allow_outside_workspace: true })

describe('isPrivateHostname', () => {
  it('catches loopback/private/link-local in every literal spelling', () => {
    for (const host of [
      '127.0.0.1', '10.0.0.5', '172.16.9.9', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fd00::1', 'fe80::1',
    ]) {
      expect(isPrivateHostname(host), host).toBe(true)
    }
  })

  it('catches the numeric/shorthand spellings `new URL()` normalizes first', () => {
    // The guard only ever sees `url.hostname`, and the WHATWG parser folds every one
    // of these into a dotted quad — which is why the literal check cannot be bypassed.
    for (const spelling of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://127.000.000.001/']) {
      const { hostname } = new URL(spelling)
      expect(isPrivateHostname(hostname), `${spelling} → ${hostname}`).toBe(true)
    }
  })

  it('catches an IPv4-mapped IPv6 literal in both spellings', () => {
    // WHATWG URL renders `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]` (hex groups).
    expect(isPrivateHostname(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true)
    expect(isPrivateHostname(new URL('http://[::ffff:7f00:1]/').hostname)).toBe(true)
    expect(isPrivateHostname(new URL('http://[::ffff:10.0.0.1]/').hostname)).toBe(true)
  })

  it('catches LAN-by-construction names, including the trailing-dot FQDN form', () => {
    for (const host of ['localhost', 'localhost.', 'api.localhost', 'printer.local', 'vault.internal', 'x.home.arpa']) {
      expect(isPrivateHostname(host), host).toBe(true)
    }
  })

  it('lets a public address through', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', 'example.com', 'huggingface.co', '2606:4700::1111', '172.32.0.1']) {
      expect(isPrivateHostname(host), host).toBe(false)
    }
  })
})

describe('resolveLocalSource', () => {
  let dir: string
  let workspace: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'avf-guard-'))
    workspace = join(dir, 'ws')
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'docs', 'a.md'), 'inside')
    writeFileSync(join(dir, 'secret.txt'), 'outside')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('accepts a path inside an allowed root and returns its realpath', () => {
    expect(resolveLocalSource(join(workspace, 'docs', 'a.md'), limits({ local_roots: [workspace] })))
      .toBe(join(workspace, 'docs', 'a.md'))
  })

  it('refuses a path outside the roots unless explicitly allowed', () => {
    expect(() => resolveLocalSource(join(dir, 'secret.txt'), limits({ local_roots: [workspace] })))
      .toThrow(/超出允许范围/)
    expect(resolveLocalSource(join(dir, 'secret.txt'), OUTSIDE)).toBe(join(dir, 'secret.txt'))
  })

  it('cannot be escaped with ".."', () => {
    expect(() => resolveLocalSource(join(workspace, '..', 'secret.txt'), limits({ local_roots: [workspace] })))
      .toThrow(/超出允许范围/)
  })

  it('cannot be escaped with a symlink', () => {
    symlinkSync(join(dir, 'secret.txt'), join(workspace, 'link.md'))
    expect(() => resolveLocalSource(join(workspace, 'link.md'), limits({ local_roots: [workspace] })))
      .toThrow(/超出允许范围/)
  })

  it('does not accept a sibling whose name merely starts with the root', () => {
    const sibling = `${workspace}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'x.md'), 'nope')
    expect(() => resolveLocalSource(join(sibling, 'x.md'), limits({ local_roots: [workspace] })))
      .toThrow(/超出允许范围/)
  })

  it('defaults to the process workspace when no root is configured', () => {
    expect(allowedLocalRoots(limits())).toEqual(allowedLocalRoots({ local_roots: [process.cwd()] }))
  })
})

describe('http(s) ingestion boundary (end to end)', () => {
  let dir: string
  let rt: AvantfRuntime
  let server: Server
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'avf-guard-http-'))
    server = createServer((req, res) => {
      if (req.url === '/bounce') { res.writeHead(302, { location: '/doc' }); res.end(); return }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('远端文档：网关由平台组维护。')
    })
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r() }) })
    port = (server.address() as { port: number }).port
  })
  afterEach(() => {
    rt?.shutdown()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** `ingest` is part of the KNOWLEDGE store config, i.e. `<home>/knowledge/config.yaml`. */
  const open = (yaml?: string): AvantfRuntime => {
    // `domains: []` — the fixtures use `d`/`s`, which the shipped allowlist would refuse.
    allowAnyDomain(dir, yaml ?? '')
    rt = buildRuntime({ dataHome: dir })
    return rt
  }

  it('refuses a private/loopback URL BEFORE connecting (default)', async () => {
    open()
    // The guard must fire on its own account: the error is the boundary's, not a
    // connection failure (the port is live, so a real attempt would have succeeded).
    await expect(rt.kb({ action: 'ingest', source_uri: `http://127.0.0.1:${String(port)}/doc`, domain: 'd', source: 's' }))
      .rejects.toThrow(/loopback\/私网地址/)
    await expect(rt.kb({ action: 'ingest', source_uri: 'http://169.254.169.254/latest/meta-data/', domain: 'd', source: 's' }))
      .rejects.toThrow(/loopback\/私网地址/)
    await expect(rt.kb({ action: 'ingest', source_uri: 'http://localhost:1/x', domain: 'd', source: 's' }))
      .rejects.toThrow(/loopback\/私网地址/)
  })

  it('fetches a private URL when the operator opts in, following redirects', async () => {
    open('ingest:\n  allow_private_network: true\n')
    const base = `http://127.0.0.1:${String(port)}`
    const res = (await rt.kb({ action: 'ingest', source_uri: `${base}/bounce`, domain: 'd', source: 's' })) as { doc_id: number; chunks: number }
    expect(res.chunks).toBeGreaterThan(0)
    const detail = (await rt.kb({ action: 'detail', doc_id: res.doc_id })) as { chunks: { text: string }[] }
    expect(detail.chunks.map((c) => c.text).join('')).toContain('网关由平台组维护')
  })

  it('gives up on a redirect loop instead of spinning', async () => {
    open('ingest:\n  allow_private_network: true\n')
    await expect(rt.kb({ action: 'ingest', source_uri: `http://127.0.0.1:${String(port)}/loop`, domain: 'd', source: 's' }))
      .rejects.toThrow(/重定向次数过多/)
  })

  it('refuses a redirect that leaves the allowed space', async () => {
    // Hop 1 is public (a name that is not a private literal), hop 2 points back at
    // loopback: following redirects in the transport would land on 127.0.0.1.
    const publicName = 'guard-test.invalid'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://') || url.startsWith('http://guard-test.invalid')) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${String(port)}/doc` } }))
      }
      return realFetch(input as Parameters<typeof fetch>[0], init)
    }) as typeof fetch
    try {
      open()
      await expect(rt.kb({ action: 'ingest', source_uri: `http://${publicName}/start`, domain: 'd', source: 's' }))
        .rejects.toThrow(/loopback\/私网地址/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('local ingestion boundary (end to end)', () => {
  let dir: string
  let rt: AvantfRuntime
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'avf-guard-local-')) })
  afterEach(() => { rt?.shutdown(); rmSync(dir, { recursive: true, force: true }) })

  it('refuses a source_uri outside the workspace by default, and accepts it when configured', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'avf-outside-'))
    const outside = join(outsideDir, 'secret.md')
    writeFileSync(outside, '外部机密内容。')
    try {
      allowAnyDomain(dir)
      rt = buildRuntime({ dataHome: dir })
      await expect(rt.kb({ action: 'ingest', source_uri: outside, domain: 'd', source: 's' }))
        .rejects.toThrow(/超出允许范围/)
      rt.shutdown()

      allowAnyDomain(dir, `ingest:\n  local_roots:\n    - ${outsideDir}\n`)
      rt = buildRuntime({ dataHome: dir })
      const res = (await rt.kb({ action: 'ingest', source_uri: outside, domain: 'd', source: 's' })) as { chunks: number }
      expect(res.chunks).toBeGreaterThan(0)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('applies the same boundary to kb_import', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'avf-outside-import-'))
    writeFileSync(join(outsideDir, 'a.md'), '外部内容。')
    try {
      allowAnyDomain(dir)
      rt = buildRuntime({ dataHome: dir })
      await expect(rt.kb({ action: 'import', paths: [outsideDir], domain: 'd', source: 's' }))
        .rejects.toThrow(/超出允许范围/)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
