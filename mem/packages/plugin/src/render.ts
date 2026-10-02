/**
 * The ONE model-facing output boundary of the eight mem tools (`TOOL_SPECS`; `kb_manage` is
 * `KB_TOOL`, the internal engine API the UI/CLI dispatch through, and is not part of the model
 * surface).
 *
 * `output.render` is what the DSH tool runner calls to turn a result value into the text block the
 * model reads, so this is the last code of ours the payload passes through before `JSON.stringify`.
 * The recursion is there because the value can contain data this process did not just write: a row
 * from a database an older build (or a different driver) filled, or a string derived by the
 * tokenizer. `JSON.stringify` emits a lone surrogate as the escape `"\ud800"`, which JavaScript
 * parses back but a strict parser rejects — repairing every string first means the text block is
 * always strictly parseable, whatever the payload's provenance.
 *
 * The repair itself is NOT this module's: `toWellFormedDeep` resolves to the loaded base kit's
 * implementation when the mount adopted it, and to `@avantf/mem-contract`'s mirror otherwise (see
 * that module's note and `index.ts`'s `adoptWellFormed` call).
 *
 * Extracted from `index.ts` so the boundary is testable without the DSH harness: this module only
 * type-imports the peer type, which is erased at transpile (see `vitest.config.ts`).
 *
 * @module plugin/render
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toWellFormedDeep } from '@avantf/mem-contract'

/** The tool output spec registered on every mem tool. */
export const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: JsonValue): { type: 'text'; text: string }[] => [
    { type: 'text', text: JSON.stringify(toWellFormedDeep(value), null, 2) },
  ],
} as const
