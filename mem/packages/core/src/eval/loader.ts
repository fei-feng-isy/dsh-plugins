import { readFileSync } from 'node:fs'

export interface EvalQuery {
  query: string
  k: number
  expected_ids: number[]
  must_include: number[]
  must_exclude: number[]
}

export interface EvalCase {
  id: string
  tags: string[]
  setup_facts: string[]
  queries: EvalQuery[]
}

/**
 * Parse the 29-query eval fixture. Each line is one case with
 * `setup_facts` (ordered) and `queries` whose id lists are indices into setup_facts.
 */
export function loadEvalCases(path: string): EvalCase[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  return lines.map((line) => {
    const raw = JSON.parse(line) as {
      id: string
      tags?: string[]
      setup_facts: { content: string }[]
      queries: { query: string; k: number; expected_ids: number[]; must_include?: number[]; must_exclude?: number[] }[]
    }
    return {
      id: raw.id,
      tags: raw.tags ?? [],
      setup_facts: raw.setup_facts.map((f) => f.content),
      queries: raw.queries.map((q) => ({
        query: q.query,
        k: q.k,
        expected_ids: q.expected_ids ?? [],
        must_include: q.must_include ?? [],
        must_exclude: q.must_exclude ?? [],
      })),
    }
  })
}
