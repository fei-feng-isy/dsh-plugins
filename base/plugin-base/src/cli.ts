#!/usr/bin/env node
/**
 * `provision` CLI — the offline `provision lint` command.
 * @module cli
 */
import { readFile } from 'node:fs/promises'
import { lintManifestText } from './lint.js'

const USAGE = '用法：provision lint <manifest.json>'

/** Run the CLI and return the process exit code: 0 ok, 1 lint findings, 2 usage/IO error. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, file] = argv
  if (command !== 'lint' || file === undefined) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    process.stderr.write(`无法读取 ${file}：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const result = lintManifestText(text)
  for (const finding of result.findings) {
    const where = finding.itemId === undefined ? '' : `${finding.itemId}: `
    process.stdout.write(`${where}[${finding.rule}] ${finding.message}\n`)
  }
  if (result.ok) {
    process.stdout.write('provision lint: ok\n')
    return 0
  }
  process.stderr.write(`provision lint: ${String(result.findings.length)} 个问题\n`)
  return 1
}

process.exitCode = await main(process.argv.slice(2))
