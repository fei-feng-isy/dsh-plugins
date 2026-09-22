/**
 * The registry's job: first claimant wins, a claimant that fails says so, and adding a format is
 * only a `registerConverter` call.
 */
import { describe, it, expect } from 'vitest'
import { converters, convertToMarkdown, registerConverter } from '../src/index.js'
import type { ConvertedDocument, ConvertInput, MarkdownConverter } from '../src/types.js'

const encoder = new TextEncoder()
const text = (value: string): Uint8Array => encoder.encode(value)

/** A converter that claims documents starting with `marker`. */
function stub(id: string, marker: string, outcome: string | Error): MarkdownConverter {
  return {
    id,
    sniff: (input: ConvertInput) => new TextDecoder().decode(input.bytes.subarray(0, marker.length)) === marker,
    convert: async (input: ConvertInput): Promise<ConvertedDocument> => {
      if (outcome instanceof Error) throw outcome
      return { markdown: outcome, converter: id, warnings: [`来自 ${id}`], title: input.path }
    },
  }
}

registerConverter(stub('test-first', 'CASE:order', '第一个转换器'))
registerConverter(stub('test-second', 'CASE:order', '第二个转换器'))
registerConverter(stub('test-fail', 'CASE:fail', new Error('内部失败')))
registerConverter(stub('test-after', 'CASE:fail', '不该到这里'))

describe('convertToMarkdown', () => {
  it('returns null when no converter claims the bytes', async () => {
    await expect(convertToMarkdown({ bytes: text('CASE:none\n普通文本'), path: 'notes.md' })).resolves.toBeNull()
  })

  it('takes the FIRST claimant, in registration order', async () => {
    const result = await convertToMarkdown({ bytes: text('CASE:order 正文'), path: 'x.md' })
    expect(result?.converter).toBe('test-first')
    expect(result?.markdown).toBe('第一个转换器')
    expect(result?.warnings).toEqual(['来自 test-first'])
  })

  it('reports a claimant’s failure instead of falling through or emitting garbage', async () => {
    await expect(convertToMarkdown({ bytes: text('CASE:fail 正文'), path: 'x.md' }))
      .rejects.toThrow(/文档转换失败（test-fail）：内部失败/)
  })

  it('exposes the registry in precedence order and as a copy', () => {
    const ids = converters().map(converter => converter.id)
    expect(ids.slice(0, 2)).toEqual(['pandoc-3.11', 'xlsx'])
    const copy = converters() as MarkdownConverter[]
    copy.push(stub('test-mutator', 'CASE:never', 'x'))
    expect(converters().some(converter => converter.id === 'test-mutator')).toBe(false)
  })

  it('refuses a duplicate id', () => {
    expect(() => registerConverter(stub('test-first', 'CASE:dup', 'x'))).toThrow(/转换器 id 重复注册：test-first/)
  })
})

describe('the built-in registry', () => {
  it('does not claim plain prose without an extension hint', async () => {
    await expect(convertToMarkdown({ bytes: text('这是一段普通文本，没有扩展名，也不是表格。') })).resolves.toBeNull()
  })
})
