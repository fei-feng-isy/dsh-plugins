/**
 * The converter registry.
 *
 * Registration order IS precedence: {@link convertToMarkdown} takes the first converter whose
 * `sniff` says yes, so a new format is added by implementing {@link MarkdownConverter} and
 * registering it — the ingestion pipeline never learns the format's name. The built-in order is
 * `pandoc` first (the canonical, version-pinned converter, which claims every format its reader
 * table covers), then the `xlsx` converter (claimed by its archive entries); the two cannot collide.
 *
 * @module registry
 */
import type { ConvertInput, ConvertedDocument, MarkdownConverter } from './types.js'

const REGISTRY: MarkdownConverter[] = []

/** A converter's failure message, without leaking a non-Error throw as "[object Object]". */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Add a converter. Ids are unique: a duplicate `id` means two implementations claim the same
 * provenance string, and the second would be unreachable (the first always wins the same format) —
 * a programming error, so it throws instead of being absorbed.
 */
export function registerConverter(converter: MarkdownConverter): void {
  if (REGISTRY.some(existing => existing.id === converter.id)) {
    throw new Error(`转换器 id 重复注册：${converter.id}`)
  }
  REGISTRY.push(converter)
}

/** The registered converters, in precedence order (a copy — callers cannot reorder the registry). */
export function converters(): readonly MarkdownConverter[] {
  return [...REGISTRY]
}

/**
 * The first converter that claims these bytes, or `null` when none does.
 *
 * A claimant that THROWS propagates: once a converter has said "this document is mine", failing to
 * convert it must be reported. Falling through to the next converter (or to the text path) would
 * turn an unsupported docx into mojibake chunks — the exact silent failure this package exists to
 * prevent.
 */
export async function convertToMarkdown(input: ConvertInput): Promise<ConvertedDocument | null> {
  for (const converter of REGISTRY) {
    if (!converter.sniff(input)) continue
    try {
      return await converter.convert(input)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`文档转换失败（${converter.id}）`)) throw error
      throw new Error(`文档转换失败（${converter.id}）：${describeError(error)}`)
    }
  }
  return null
}
