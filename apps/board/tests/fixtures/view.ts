import { type } from 'arktype'
import { BoardViewSchema, type BoardCard } from '../../src/board/board-contract'
import raw from './view.json'

const parsed = BoardViewSchema(raw)
if (parsed instanceof type.errors) throw new Error(`view.json no longer matches the contract: ${parsed.summary}`)

/** A `view` captured from the real CLI on a scratch board (see tests/capture-fixture.ts). */
export const fixtureView = parsed

export function cardOf(id: number): BoardCard {
  const card = [...fixtureView.tasks, ...fixtureView.closed.tasks].find((candidate) => candidate.id === id)
  if (!card) throw new Error(`fixture has no task ${id}`)
  return card
}
