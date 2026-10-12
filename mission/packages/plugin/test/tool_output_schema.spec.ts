/**
 * Every mission tool DECLARES its answer shape, and the declaration is ENFORCED.
 *
 * `defineTool` compiles `output.schema` to the raw JSON Schema subset and `tools.register` asserts
 * that subset (`assertSupportedJsonSchema`); the registry then validates EVERY successful canonical
 * value against it, refusing the call with `INVALID_TOOL_OUTPUT` when the body drifts
 * (`packages/core/tools/src/index.ts`, `createSuccessResult`). Before this suite the nine tools shared
 * one `{ type: 'object', additionalProperties: true }`, so a body that stopped writing a field (or
 * started writing a new one) could never be noticed.
 *
 * Each tool is driven through the real mount for one SUCCESS and one DEGRADED answer — and every case
 * is judged by the REGISTRY'S OWN validator against the schema the tool actually registered, because a
 * test-local re-statement of the shape would only prove the test agrees with itself.
 */
import { describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { callTool, executorFor, mount, type Mounted } from './mount.js'

/** The nine tools whose answers are declared (same list `degraded-mount.spec.ts` pins). */
const TOOL_NAMES = [
  'create_mission',
  'adjust_mission',
  'note_mission',
  'decompose_mission',
  'submit_mission',
  'mission_result',
  'list_missions',
  'finish_mission',
  'cancel_mission',
] as const

/**
 * One VALID argument object per tool: valid enough to pass the declared parameter schema and reach
 * `execute`, while touching no state (the ids do not exist, and the no-caller path returns before any
 * engine call).
 */
const CALL_ARGUMENTS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  create_mission: { title: 'T', description: 'd' },
  adjust_mission: { root_id: 'deadbeef', adjustment: 'x' },
  cancel_mission: { root_id: 'deadbeef' },
  decompose_mission: { node_id: 'deadbeef', children: [{ title: 'A', description: 'a' }] },
  note_mission: { node_id: 'deadbeef', analysis: 'x' },
  submit_mission: { node_id: 'deadbeef', result: 'x' },
  mission_result: { node_id: 'deadbeef' },
  list_missions: {},
  finish_mission: { root_id: 'deadbeef' },
}

/** The output contract as the stub registry keeps it (the harness only types `render`). */
interface RegisteredOutput {
  schema: JsonSchemaNode
  render: (args: unknown, value: unknown) => readonly { type: string; text: string }[]
}

/** One `oneOf` branch of a compiled output schema, as this suite reads it. */
interface Branch {
  type?: string
  additionalProperties?: boolean
  required?: string[]
  properties?: Record<string, { const?: unknown }>
}

/**
 * The registered definition of one tool, with its output contract.
 *
 * The nine tools live in TWO agent scopes now (six with an owner, three with a worker), so a spec that
 * wants to inspect any of them has to make both faces exist. This materializes them once per mount
 * through the fixture's own lifecycle (`create_mission` + the dispatch it starts) and then looks the
 * definition up in the harness's union ledger.
 */
function definitionOf(mounted: Mounted, name: string): Mounted['registered'][number] {
  materializeBothFaces(mounted)
  const tool = mounted.registered.find((entry) => entry.name === name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool
}

const facesReady = new WeakSet<Mounted>()
function materializeBothFaces(mounted: Mounted): void {
  if (facesReady.has(mounted)) return
  facesReady.add(mounted)
  // The owner face is installed at mount; the worker face needs a real dispatched worker session.
  // `workerFor` is the fixture's stand-in for one, and it is idempotent.
  mounted.workerFor('mission-00000001')
}

function outputOf(mounted: Mounted, name: string): RegisteredOutput {
  const output = (definitionOf(mounted, name) as { output?: RegisteredOutput }).output
  if (output === undefined) throw new Error(`tool ${name} declares no output contract`)
  return output
}

/**
 * Validate one answer the way the registry does: assert the schema is in the supported subset (what
 * `register` does) and return the value violations (what `createSuccessResult` throws on).
 */
function violationsOf(mounted: Mounted, name: string, value: unknown): string[] {
  const schema = outputOf(mounted, name).schema
  assertSupportedJsonSchema(schema)
  return validateJsonSchemaValue(schema, value)
}

/** A store that cannot be opened is the real DEGRADED mount: every tool answers "not ready + reason". */
async function degradedMount(): Promise<Mounted> {
  const mounted = await mount({ failDomainOpen: true })
  expect(mounted.host.degradedReason()).toContain('could not be opened')
  return mounted
}

/**
 * One SUCCESS value per tool, produced by running one real mission lifecycle end to end:
 * create → adjust (recorded, nobody holds it yet) → dispatch → note → decompose → dispatch the child →
 * submit the child → read it → list → cancel the tree → read the root (the finish gate) → finish.
 */
async function successReturns(mounted: Mounted): Promise<Map<string, unknown>> {
  const owner = mounted.owner
  const returns = new Map<string, unknown>()

  const created = await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: ['why'] }, owner)
  returns.set('create_mission', created)
  const root = String(created.data?.['root_id'] ?? '')
  expect(root).not.toBe('')

  // The root is `ready` and nobody holds it, so the correction is RECORDED (delivered: false, voided: 0).
  returns.set('adjust_mission', await callTool(mounted, 'adjust_mission', { root_id: root, adjustment: '先做 B' }, owner))

  await mounted.flush()
  const worker = executorFor(mounted, root)
  returns.set('note_mission', await callTool(mounted, 'note_mission', { node_id: root, analysis: '为什么拆：缺一个前置事实' }, worker))

  const split = await callTool(
    mounted,
    'decompose_mission',
    { node_id: root, children: [{ title: 'A', description: 'a', context: ['why a'] }] },
    worker,
  )
  returns.set('decompose_mission', split)
  const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
  expect(child).not.toBe('')

  await mounted.flush()
  const childWorker = executorFor(mounted, child)
  returns.set('submit_mission', await callTool(mounted, 'submit_mission', { node_id: child, result: 'A 的结论' }, childWorker))
  returns.set('mission_result', await callTool(mounted, 'mission_result', { node_id: child }, owner))
  returns.set('list_missions', await callTool(mounted, 'list_missions', {}, owner))
  returns.set('cancel_mission', await callTool(mounted, 'cancel_mission', { root_id: root }, owner))
  // Reading the root is the `finish_mission` gate (a tree is only retired after its result was read).
  const readRoot = await callTool(mounted, 'mission_result', { node_id: root }, owner)
  expect(readRoot.ok).toBe(true)
  returns.set('finish_mission', await callTool(mounted, 'finish_mission', { root_id: root }, owner))

  expect([...returns.keys()].sort()).toEqual([...TOOL_NAMES].sort())
  return returns
}

describe('each mission tool validates its own declared output schema', () => {
  it('admits one real SUCCESS value per tool', async () => {
    const mounted = await mount()
    const returns = await successReturns(mounted)
    for (const name of TOOL_NAMES) {
      const value = returns.get(name)
      expect(value, `${name} produced no success value`).toMatchObject({ ok: true })
      expect(typeof (value as { summary?: unknown }).summary).toBe('string')
      expect(violationsOf(mounted, name, value), `${name} rejects its own success answer`).toEqual([])
    }
  })

  it('admits one real DEGRADED value per tool', async () => {
    const mounted = await degradedMount()
    for (const name of TOOL_NAMES) {
      const value = await callTool(mounted, name, CALL_ARGUMENTS[name], mounted.owner)
      expect(value).toMatchObject({ ok: false, data: { code: 'not-ready' } })
      expect(violationsOf(mounted, name, value), `${name} rejects its own not-ready answer`).toEqual([])
    }
  })

  it('admits the NO_CALLER answer per tool', async () => {
    const mounted = await mount()
    for (const name of TOOL_NAMES) {
      // No `agent` in the execution context: the same branch a non-agent caller takes.
      const value = await definitionOf(mounted, name).execute(CALL_ARGUMENTS[name], {
        concludeTurn: () => undefined,
      })
      expect(value).toMatchObject({ ok: false, data: { code: 'no-caller' } })
      expect(violationsOf(mounted, name, value), `${name} rejects its own no-caller answer`).toEqual([])
    }
  })

  it('admits a genuine engine REFUSAL against every tool (the failure branch is shared)', async () => {
    // `fail(refusal)` is the third producer of the failure branch: an engine refusal, not a
    // degradation. `mission_result` on an unknown node is one real instance of it.
    const mounted = await mount()
    const refused = await callTool(mounted, 'mission_result', { node_id: 'deadbeef' }, mounted.owner)
    expect(refused).toMatchObject({ ok: false, data: { code: 'not-found' } })
    for (const name of TOOL_NAMES) {
      expect(violationsOf(mounted, name, refused), `${name} rejects the fail(refusal) shape`).toEqual([])
    }
  })
})

describe('the declared schemas are real contracts, not `additionalProperties: true` shells', () => {
  it('gives every tool a two-branch oneOf whose required covers ok and summary', async () => {
    const mounted = await mount()
    for (const name of TOOL_NAMES) {
      const schema = outputOf(mounted, name).schema as unknown as { type?: string; oneOf?: Branch[] }
      // The old shared shell was exactly this: an open object with no branches and no required.
      expect(schema.type, `${name} is still a bare object shell`).toBeUndefined()
      expect(Array.isArray(schema.oneOf), `${name} has no oneOf`).toBe(true)
      const branches = schema.oneOf ?? []
      expect(branches, `${name} must have exactly two branches`).toHaveLength(2)
      for (const branch of branches) {
        expect(branch.type, `${name} branch is not an object`).toBe('object')
        expect(branch.additionalProperties, `${name} branch is open (additionalProperties !== false)`).toBe(false)
        expect(branch.required, `${name} branch does not require ok and summary`).toEqual(expect.arrayContaining(['ok', 'summary']))
      }
      // The branches are discriminated by `ok`, so exactly one can ever match.
      expect(branches.map((branch) => branch.properties?.['ok']?.const).sort()).toEqual([false, true])
    }
  })

  it('refuses a value that drifts from the declaration', async () => {
    const mounted = await mount()
    // A required `data` disappears.
    expect(violationsOf(mounted, 'create_mission', { ok: true, summary: 'x' }).length).toBeGreaterThan(0)
    // An undeclared field appears (the exact drift an open schema would hide).
    const withExtra = { ok: true, summary: 'x', data: { root_id: 'r', surprise: 1 } }
    expect(violationsOf(mounted, 'create_mission', withExtra).length).toBeGreaterThan(0)
    // The wrong `ok` branch: `data.root_id` is not the failure shape.
    expect(violationsOf(mounted, 'create_mission', { ok: false, summary: 'x', data: { root_id: 'r' } }).length).toBeGreaterThan(0)
  })

  it('keeps list_missions answers without data valid (the empty-store success)', async () => {
    const mounted = await mount()
    const empty = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(empty).toEqual({ ok: true, summary: '本会话没有任务。' })
    expect(violationsOf(mounted, 'list_missions', empty)).toEqual([])
  })
})
