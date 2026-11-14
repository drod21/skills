import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { type } from 'arktype'

import { launchJevCli, readJevInput, runBatch, validateJevText, type BatchInput, type JevClient } from './jev-batch.ts'

export const selectionSchema = type({
  mode: "'filter' | 'compact'",
  goal: '0 < string <= 4000',
  'summary?': '0 < string <= 8000',
  sections: type({
    id: '0 < string <= 100',
    source: '0 < string <= 1000',
    offset: 'number.integer >= 0',
    text: '0 < string <= 1000000',
    'pinned?': 'boolean',
  })
    .array()
    .atLeastLength(1)
    .atMostLength(500),
})
export type SelectionInput = typeof selectionSchema.infer

export async function selectEvidence(input: SelectionInput, out: string, client?: JevClient) {
  const seen = new Set<string>()
  const sections = input.sections.flatMap((section) => {
    if (seen.has(section.id)) throw new Error(`duplicate section ${section.id}`)
    seen.add(section.id)
    validateJevText(section.text, section.id)
    validateJevText(section.source, 'source')
    const parts = []
    for (let offset = 0; offset < section.text.length; offset += 5000) {
      parts.push({
        ...section,
        part: offset / 5000,
        offset: section.offset + offset,
        text: section.text.slice(offset, offset + 5000),
      })
    }
    return parts
  })
  const candidates = sections.map((section, index) => ({ ...section, questionId: `section_${index}` }))
  const items: BatchInput['items'] = candidates
    .filter((s) => input.summary !== undefined || !s.pinned)
    .map((section) => ({
      id: section.questionId,
      context: section.text,
      ask: {
        kind: 'yes_no',
        question: input.summary
          ? 'Can all facts needed for the goal in this source excerpt be recovered accurately from the supplied summary?'
          : 'Does this source excerpt contain facts needed to fulfill the goal, including constraints, decisions, blockers, or evidence?',
      },
    }))
  const results = items.length
    ? await runBatch(
        {
          context: input.summary ? `${input.goal}\nSummary to verify:\n${input.summary}` : input.goal,
          items,
        },
        out,
        client,
      )
    : []
  const decisions = candidates.map((section) => {
    const result = results.find((r) => r.id === section.questionId)
    const keep = input.summary !== undefined || section.pinned || result?.result.answer !== 'no'
    return {
      ...section,
      keep,
      reason: section.pinned ? 'pinned' : result?.result.outcome === 'hold' ? 'uncertain' : result?.result.answer,
      receipt: result?.receipt ?? null,
    }
  })
  const kept = decisions.filter((s) => s.keep)
  const omitted = decisions.filter((s) => !s.keep)
  const verification =
    input.summary !== undefined
      ? results.every((r) => r.result.outcome === 'answered' && r.result.answer === 'yes')
      : null
  const plan = {
    mode: input.mode,
    goal: input.goal,
    summary: input.summary ?? null,
    verified: verification,
    kept,
    omitted: input.mode === 'filter' ? omitted : [],
    toSummarize: input.mode === 'compact' ? omitted : [],
    results,
  }
  const artifact = join(resolve(out), `selection-${randomUUID()}.json`)
  mkdirSync(out, { recursive: true })
  writeFileSync(artifact, JSON.stringify(plan, null, 2), { flag: 'wx' })
  return {
    artifact,
    kept: kept.length,
    omitted: omitted.length,
    verified: verification,
    outcome: results.some((r) => r.result.outcome === 'hold')
      ? 'hold'
      : verification === false
        ? 'rejected'
        : 'answered',
  }
}

export async function selectionMain(argv = process.argv.slice(2), client?: JevClient) {
  const [file, flag, out] = argv
  if (!file || flag !== '--out' || !out || argv.length !== 3)
    throw new Error('usage: node scripts/jev-select.ts input.json --out artifact-directory')
  const result = await selectEvidence(readJevInput(file, selectionSchema.assert), out, client)
  console.log(JSON.stringify(result))
  return result.outcome === 'answered' ? 0 : result.outcome === 'rejected' ? 2 : 3
}

launchJevCli(import.meta.url, selectionMain)
