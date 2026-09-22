import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETENTION_VOCABULARY } from '@avantf/mem-contract'
import {
  KB_EDIT_PROMPT_SECTION,
  KNOWLEDGE_PROMPT_SECTION,
  MEMORY_PROMPT_SECTION,
  PROMPT_FILES,
  PROMPT_TEXT_BUDGET,
  buildPromptSections,
  promptFileSpecs,
  promptTextWarnings,
} from '../src/prompt.js'
import { PromptFiles } from '@avantf/dsh-plugin-base'

/**
 * The plugin contributes two system-prompt sections: WHEN to write and read memory, and WHEN to
 * query the document library.
 *
 * The knowledge one exists because its absence was measured, not because it sounded useful:
 * 《Cgroup v2 技术综述》 was already in the store (`kb_query` answers "cgroup v2 的内存保护" at
 * score 1.0) and a session asked about it anyway — the prompt named only the memory tools, and
 * `kb_query`'s own description leads with 记忆 facts, so it reads as a memory tool. Hence the two
 * properties pinned below: the section names `kb_query`, and it says the model cannot see what the
 * library holds. That second clause is the one that makes the model CHECK instead of deciding from
 * what it already knows.
 *
 * Three properties are load-bearing and none is visible to the contract's tool-description guard,
 * because this text never passes through a tool schema:
 *
 *  - each section must name the tools it is about, or the nudge is unreachable in practice;
 *  - neither may explain how memory is RETAINED. The store owns those clocks, the model cannot
 *    observe them, and the one action such text invites is rewriting a fact to "refresh" it —
 *    which defeats the policy it just described. The vocabulary list is imported from the
 *    contract so the guards cannot drift apart;
 *  - both are rendered into EVERY model step, so both are budgeted like prompt text.
 *
 * The sections are imported from `src/prompt.ts`, not `src/index.ts`: the entry pulls in
 * `@deepseek-ai/*` runtime imports that only exist in a harness workspace, while this suite runs
 * in CI. The `inject`/registration pairing is asserted by `scripts/mount-smoke.mjs` instead.
 */
describe('plugin prompt sections', () => {
  it('places both in the third-party slot (memory first) and keeps each short enough to earn its tokens', () => {
    expect(MEMORY_PROMPT_SECTION.name).toBe('avantf:memory-usage')
    expect(KNOWLEDGE_PROMPT_SECTION.name).toBe('avantf:knowledge-usage')
    // A third-party slot: after the harness's per-tool guidance (1000–2900), before the toolset
    // guidance (5000). A later change of order is a deliberate placement change, not a nit.
    expect(MEMORY_PROMPT_SECTION.order).toBe(3000)
    expect(KNOWLEDGE_PROMPT_SECTION.order).toBe(3010)
    expect(KB_EDIT_PROMPT_SECTION.name).toBe('avantf:kb-edit')
    expect(KB_EDIT_PROMPT_SECTION.order).toBe(3020)
    for (const section of [MEMORY_PROMPT_SECTION, KNOWLEDGE_PROMPT_SECTION, KB_EDIT_PROMPT_SECTION]) {
      expect(section.text.length, `${section.name} is rendered into every step`).toBeLessThan(400)
    }
  })

  it('names the memory tools and states the proactive behaviour: remember important facts, recall before answering', () => {
    // The reason this section exists at all — a tool description says what a call does, never
    // when to reach for it unprompted.
    expect(MEMORY_PROMPT_SECTION.text).toContain('mem_remember')
    // RECALL guidance was REMOVED on purpose: every user message now gets a conditional hint when
    // the memory store actually holds something related, so a standing "recall before answering"
    // rule only spends tokens on every step. The section is write-side only.
    expect(MEMORY_PROMPT_SECTION.text).not.toContain('mem_recall')
    expect(MEMORY_PROMPT_SECTION.text).toContain('主动')
    // "不必等用户开口" was dropped as emphasis, not information: the imperative `主动` already
    // carries it. Pinned so it does not drift back in.
    expect(MEMORY_PROMPT_SECTION.text).not.toContain('不必等用户开口')
    // The unwritten half of "remember more" is "remember less": without this the text would trade
    // a silent memory for a noisy one.
    expect(MEMORY_PROMPT_SECTION.text).toContain('不要记录')
  })

  it('defines what belongs in the library, and how to cite it', () => {
    // `你看不到库里有什么` is load-bearing: without it the model can only judge whether the library
    // is relevant from what it already knows — the reasoning that skipped the ingested
    // 《Cgroup v2 技术综述》. The clause is what turns "there is a store" into "go look".
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('kb_query')
    // The DEFINITION is what the section must carry now, and `踩坑` must stay out of it: that is
    // memory's territory, and listing it in both places is the conflict this states away.
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('用户提供的成篇资料')
    expect(KNOWLEDGE_PROMPT_SECTION.text).not.toContain('踩坑')
    // The action, and the order it happens in: query BEFORE answering, not after being asked.
    // Retrieval before answering, and the citation rule — the one piece of kb_query prose kept.
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('先用 `kb_query` 检索')
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('`source_ref` 引用原文')
    // `kb_add` is named for the WRITE half, which the user asked to be proactive: content worth
    // keeping is added without waiting to be asked. It now REFUSES an existing triple, and the
    // section has to say so — being told to "update the KB" is what produced a sibling document.
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('kb_add')
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('主动')
    // The same-triple refusal is NOT here: `kb_add` returns it as an error, and a prompt line
    // restating a tool's own return is exactly the kind of description this pass removed.
    expect(KNOWLEDGE_PROMPT_SECTION.text).not.toContain('拒绝')
    // Add vs remember: a whole document must not be crammed into one fact (which has no length
    // limit at all), so the section has to say which store a sentence belongs in.
    expect(KNOWLEDGE_PROMPT_SECTION.text).toContain('mem_remember')
  })

  it('spells out how to CHANGE a document: a file edit, never a second kb_add', () => {
    // The section that exists because of a measured failure: told to update the KB, a model called
    // the old all-in-one tool with a NEW title and created a sibling document instead.
    expect(KB_EDIT_PROMPT_SECTION.text).toContain('kb_list')
    expect(KB_EDIT_PROMPT_SECTION.text).toContain('在原文上修改或追加')
    expect(KB_EDIT_PROMPT_SECTION.text).toContain('不要新建一个补充文档')
    // The file tool is NOT prescribed any more: `edit` fails often enough in practice that a
    // whole-file rewrite is a legitimate move, and the guarded auto-adoption covers the frontmatter
    // it destroys. What stays is WHERE to edit (the path `kb_list` hands back).
    expect(KB_EDIT_PROMPT_SECTION.text).toContain('用文件工具修改')
    expect(KB_EDIT_PROMPT_SECTION.text).not.toContain('整篇覆盖')
    // The frontmatter EXPLANATION was removed: the prompt states the constraint, and the reason
    // lives in DESIGN §10 / CHANGELOG instead of costing tokens on every step.
    expect(KB_EDIT_PROMPT_SECTION.text).not.toContain('frontmatter')
    expect(KB_EDIT_PROMPT_SECTION.text).not.toContain('身份载体')
    // Syncing and re-ingesting are no longer mentioned at all (the automatic reconcile handles
    // it, and saying so was describing mechanics); deletion keeps its one-line instruction.
    expect(KB_EDIT_PROMPT_SECTION.text).not.toContain('手动同步')
    expect(KB_EDIT_PROMPT_SECTION.text).toContain('在用户明确要求时使用 `kb_remove` 删除')
  })

  it('states what to do and never why', () => {
    // The house rule for this text: actions only. These are the explanatory phrasings that were
    // removed, kept as a guard so they do not creep back in with the next edit.
    for (const section of [MEMORY_PROMPT_SECTION, KNOWLEDGE_PROMPT_SECTION, KB_EDIT_PROMPT_SECTION]) {
      for (const why of ['因为', '否则', '原因是', '之所以', '身份载体', '无主文件']) {
        expect(section.text, `${section.name} must state actions, not reasons ("${why}")`).not.toContain(why)
      }
    }
  })

  it('never explains retention mechanics', () => {
    for (const section of [MEMORY_PROMPT_SECTION, KNOWLEDGE_PROMPT_SECTION, KB_EDIT_PROMPT_SECTION]) {
      for (const word of RETENTION_VOCABULARY) {
        expect(section.text, `${section.name} must not explain retention ("${word}")`).not.toContain(word)
      }
    }
  })
})

/**
 * The TEXTS above are editable on disk; the guards in this file only hold the built-in defaults.
 *
 * What has to stay true when a user edits them is the BOUNDARY, and that is what these cases pin:
 * one file per section, the file name → section mapping owned by code (so an edit cannot move a
 * section in the prompt or rename it), the default a missing file is filled with being the very
 * constant above rather than a copy of it, and the whole ensure → read → inject flow working against
 * a real directory. The registration itself is covered by `scripts/mount-smoke.mjs`.
 */
describe('editable prompt files', () => {
  it('maps exactly one file per section, and the identity stays in code', () => {
    expect(PROMPT_FILES.map((entry) => entry.file)).toEqual([
      'mem-memory-usage.md',
      'mem-knowledge-usage.md',
      'mem-kb-edit.md',
    ])
    expect(PROMPT_FILES.map((entry) => entry.section.name)).toEqual([
      MEMORY_PROMPT_SECTION.name,
      KNOWLEDGE_PROMPT_SECTION.name,
      KB_EDIT_PROMPT_SECTION.name,
    ])
    // The placement (order) is what an edited file must NOT be able to change.
    expect(PROMPT_FILES.map((entry) => entry.section.order)).toEqual([3000, 3010, 3020])

    // The default a missing/blank file is filled with IS the constant — not a second copy of it.
    expect(promptFileSpecs()).toEqual([
      { file: 'mem-memory-usage.md', fallback: MEMORY_PROMPT_SECTION.text },
      { file: 'mem-knowledge-usage.md', fallback: KNOWLEDGE_PROMPT_SECTION.text },
      { file: 'mem-kb-edit.md', fallback: KB_EDIT_PROMPT_SECTION.text },
    ])
  })

  it('injects what the file says and keeps each unloaded section at its default', () => {
    const sections = buildPromptSections([
      { file: 'mem-knowledge-usage.md', path: '/p/mem-knowledge-usage.md', text: '自定义知识库提示词', source: 'file', wrote: false },
    ])

    expect(sections.map((section) => section.name)).toEqual([
      'avantf:memory-usage',
      'avantf:knowledge-usage',
      'avantf:kb-edit',
    ])
    expect(sections[1]?.text).toBe('自定义知识库提示词')
    expect(sections[0]?.text).toBe(MEMORY_PROMPT_SECTION.text)
    expect(sections[2]?.text).toBe(KB_EDIT_PROMPT_SECTION.text)
    expect(sections.map((section) => section.order)).toEqual([3000, 3010, 3020])
  })

  it('round-trips through a real directory: an edited file wins, the others are created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-prompts-'))
    try {
      writeFileSync(join(dir, 'mem-kb-edit.md'), '只在原文上改，不新建文档。\n', 'utf8')

      const loaded = new PromptFiles({ dir }).load(promptFileSpecs())
      const sections = buildPromptSections(loaded)

      expect(loaded.map((entry) => entry.source)).toEqual(['default', 'default', 'file'])
      expect(sections[2]?.text).toBe('只在原文上改，不新建文档。')
      expect(sections[0]?.text).toBe(MEMORY_PROMPT_SECTION.text)
      // The two untouched sections were created on disk, holding their default text.
      expect(readFileSync(join(dir, 'mem-memory-usage.md'), 'utf8').trim()).toBe(MEMORY_PROMPT_SECTION.text)
      expect(readFileSync(join(dir, 'mem-knowledge-usage.md'), 'utf8').trim()).toBe(KNOWLEDGE_PROMPT_SECTION.text)
      // The user's file was left byte-for-byte alone.
      expect(readFileSync(join(dir, 'mem-kb-edit.md'), 'utf8')).toBe('只在原文上改，不新建文档。\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('warns about edited text that reproduces a measured regression, without touching it', () => {
    // The defaults pass all three checks (the cases above). An edited file is the user's prompt, so
    // it is injected as written — but these three shapes are measured regressions, and one log line
    // is how the user finds out.
    const clean = buildPromptSections([])
    expect(promptTextWarnings(clean)).toEqual([])

    const warned = promptTextWarnings([
      { name: 'avantf:memory-usage', order: 3000, text: '这条事实正在衰减，因为信任度会随时间下降。' },
      { name: 'avantf:kb-edit', order: 3020, text: 'x'.repeat(PROMPT_TEXT_BUDGET + 1) },
    ])
    // Retention vocabulary, an explanatory "why", and an over-budget segment — at least one line
    // each (the vocabulary word list can match more than once in one sentence).
    expect(warned.length).toBeGreaterThanOrEqual(3)
    expect(warned.some((line) => line.includes('retention'))).toBe(true)
    expect(warned.some((line) => line.includes('explains why'))).toBe(true)
    expect(warned.some((line) => line.includes(String(PROMPT_TEXT_BUDGET + 1)))).toBe(true)
  })
})
