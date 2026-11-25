import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import raw from '../../tests/fixtures/view.json'
import { BoardViewSchema } from './board-contract'
import { buildColumns, isKnownStatus } from './columns'

/** The captured view with its first live card and first needs row changed by `change`. */
function viewWith(change: (view: typeof raw) => void) {
  const view = structuredClone(raw)
  change(view)
  return BoardViewSchema.safeParse(view)
}

const parsed = (result: ReturnType<typeof viewWith>) => {
  if (!result.success) throw new Error(z.prettifyError(result.error))
  return result.data
}

describe('a value the CLI adds after this app was built', () => {
  it('reads a status it does not know instead of failing the whole view', () => {
    const view = parsed(
      viewWith((draft) => {
        const [first] = draft.tasks
        if (first) first.status = 'paused'
      }),
    )
    expect(view.tasks[0]?.status).toBe('paused')
    expect(isKnownStatus('paused')).toBe(false)
    expect(isKnownStatus('claimed')).toBe(true)
  })

  it('puts a live card with an unknown status in Open and a closed one in Done', () => {
    const view = parsed(
      viewWith((draft) => {
        const [live] = draft.tasks
        const [closed] = draft.closed.tasks
        if (live) live.status = 'paused'
        if (closed) closed.status = 'archived-elsewhere'
      }),
    )
    const built = buildColumns(view, [], '')
    expect(built.open.map((card) => card.status)).toContain('paused')
    expect(built.done.map((card) => card.status)).toContain('archived-elsewhere')
    expect(built.progress.map((card) => card.status)).not.toContain('paused')
  })

  it('reads a needs reason it does not know as plain text, with its name', () => {
    const view = parsed(
      viewWith((draft) => {
        const [row] = draft.needsOwner
        if (row) row.reasons = [{ why: 'budget', text: 'Spend over the cap' }] as never
      }),
    )
    expect(view.needsOwner[0]?.reasons).toEqual([{ why: 'other', name: 'budget', text: 'Spend over the cap' }])
  })

  it('reads an unknown reason that carries no text', () => {
    const view = parsed(
      viewWith((draft) => {
        const [row] = draft.needsOwner
        if (row) row.reasons = [{ why: 'budget' }] as never
      }),
    )
    expect(view.needsOwner[0]?.reasons).toEqual([{ why: 'other', name: 'budget', text: null }])
  })

  it('still refuses a known reason that lost its fields', () => {
    const result = viewWith((draft) => {
      const [row] = draft.needsOwner
      if (row) row.reasons = [{ why: 'question' }] as never
    })
    expect(result.success).toBe(false)
  })

  it('keeps the known reasons exactly as they were sent', () => {
    const view = parsed(viewWith(() => undefined))
    const whys = view.needsOwner.flatMap((row) => row.reasons.map((reason) => reason.why))
    expect(whys.length).toBeGreaterThan(0)
    expect(whys.every((why) => why !== 'other')).toBe(true)
  })
})
