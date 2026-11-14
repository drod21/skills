import { describe, expect, it } from 'vitest'
import { cardOf, fixtureView } from '../../tests/fixtures/view'
import { NO_FILTERS, buildColumns, closedInfo, columnCount, countLabel, fingerprint, mergeClosed } from './columns'

const ids = (cards: readonly { id: number }[]) => cards.map((card) => card.id)

describe('buildColumns', () => {
  const built = buildColumns(fixtureView, [], '')

  it('puts open tasks in the Open column by id and claimed tasks in In progress', () => {
    expect(ids(built.open)).toEqual([1, 2, 3, 4, 5, 6])
    expect(ids(built.progress).toSorted((a, b) => a - b)).toEqual([7, 8, 9])
  })

  it('splits the closed page into Done and Cancelled', () => {
    expect(ids(built.cancelled)).toEqual([14, 13])
    expect(built.done).toEqual([])
  })

  it('lists what waits on the owner and what sits with the lead', () => {
    expect(ids(built.needs.rows)).toEqual([7, 8])
    expect(ids(built.needs.lead)).toEqual([8])
  })

  it('orders In progress by the latest sign of life, then by id', () => {
    const base = cardOf(7)
    const quiet = { ...base, id: 20, lastSignalAt: '2026-01-01T00:00:00.000Z', claimedAt: '2026-01-01T00:00:00.000Z' }
    const recent = { ...base, id: 21, lastSignalAt: '2026-06-01T00:00:00.000Z' }
    const never = { ...base, id: 22, lastSignalAt: null, claimedAt: null }
    const view = { ...fixtureView, tasks: [quiet, never, recent] }
    expect(ids(buildColumns(view, [], '').progress)).toEqual([21, 20, 22])
  })

  it('narrows by text on id, title, role, tag, owner and the needs reasons', () => {
    expect(ids(buildColumns(fixtureView, [], 'browser check').open)).toEqual([3])
    expect(ids(buildColumns(fixtureView, [], '#5').open)).toEqual([5])
    expect(ids(buildColumns(fixtureView, [], 'security-worker').open)).toEqual([5])
    expect(ids(buildColumns(fixtureView, [], 'worker-backend').progress)).toEqual([8])
    expect(ids(buildColumns(fixtureView, [], 'which tab').needs.rows)).toEqual([7])
  })

  it('counts only what the owner can act on, and keeps rejected checks in their own quiet group', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const rejected = { why: 'rejected' as const, tool: 'check', canAccept: false, at }
    const hold = { why: 'hold' as const, tool: 'check', canAccept: true, at }
    const question = { why: 'question' as const, text: 'Which?', by: 'worker', at }
    const delivery = { why: 'delivery' as const, id: 'd1', entryKind: 'note', state: 'failed', detail: null, at }
    const row = (id: number, reasons: (typeof rejected | typeof hold | typeof question | typeof delivery)[]) => ({
      id,
      title: `Task ${id}`,
      status: 'claimed',
      reasons,
    })
    const view = {
      ...fixtureView,
      needsOwner: [row(1, [rejected]), row(2, [hold]), row(3, [rejected]), row(4, [delivery]), row(5, [question])],
    }
    const built = buildColumns(view, [], '')
    expect(ids(built.needs.rows)).toEqual([5, 2, 4])
    expect(ids(built.needs.rejected)).toEqual([1, 3])
    expect(columnCount('needs', built, closedInfo(view, NO_FILTERS, false))).toEqual({ value: 3, more: false })
  })

  it('keeps a row that has a rejected check and also a question among the rows the owner can act on', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const view = {
      ...fixtureView,
      needsOwner: [
        {
          id: 1,
          title: 'Mixed',
          status: 'claimed',
          reasons: [
            { why: 'rejected' as const, tool: 'check', canAccept: false, at },
            { why: 'question' as const, text: 'Which?', by: 'worker', at },
          ],
        },
      ],
    }
    const built = buildColumns(view, [], '')
    expect(ids(built.needs.rows)).toEqual([1])
    expect(built.needs.rejected).toEqual([])
  })

  it('needs every word to match, in any order', () => {
    expect(ids(buildColumns(fixtureView, [], 'board ux').open)).toEqual([1])
    expect(ids(buildColumns(fixtureView, [], 'board nonsense').open)).toEqual([])
  })
})

describe('closed pages', () => {
  it('keeps each task once when an older page overlaps the first', () => {
    const [first, second] = fixtureView.closed.tasks
    if (!first || !second) throw new Error('fixture needs two closed tasks')
    expect(ids(mergeClosed([first, second], [second, cardOf(7)]))).toEqual([14, 13, 7])
  })

  it('shows older cards after the first page', () => {
    const older = { ...cardOf(14), id: 3, status: 'done' as const }
    const built = buildColumns(fixtureView, [older], '')
    expect(ids(built.done)).toEqual([3])
    expect(ids(built.cancelled)).toEqual([14, 13])
  })
})

describe('column counts', () => {
  const built = buildColumns(fixtureView, [], '')

  it('shows the board totals for the closed columns when nothing is filtered', () => {
    const info = closedInfo(fixtureView, NO_FILTERS, true)
    expect(countLabel(columnCount('done', built, info))).toBe('2')
    expect(countLabel(columnCount('cancelled', built, info))).toBe('3')
  })

  it('shows what is loaded, with a plus while older pages remain, once a filter narrows them', () => {
    const info = closedInfo(fixtureView, { ...NO_FILTERS, role: 'qa-worker' }, true)
    expect(countLabel(columnCount('cancelled', built, info))).toBe('2+')
    expect(
      countLabel(columnCount('cancelled', built, closedInfo(fixtureView, { ...NO_FILTERS, role: 'x' }, false))),
    ).toBe('2')
  })

  it('counts the open and in-progress columns as shown', () => {
    const info = closedInfo(fixtureView, NO_FILTERS, false)
    expect(columnCount('open', built, info)).toEqual({ value: 6, more: false })
    expect(columnCount('progress', built, info)).toEqual({ value: 3, more: false })
    expect(columnCount('needs', built, info)).toEqual({ value: 2, more: false })
  })
})

describe('fingerprint', () => {
  it('changes when the card moves or a thread changes, not on a heartbeat', () => {
    const card = cardOf(9)
    expect(fingerprint({ ...card, lastSignalAt: '2030-01-01T00:00:00.000Z' })).toBe(fingerprint(card))
    expect(fingerprint({ ...card, status: 'open', owner: null })).not.toBe(fingerprint(card))
    expect(fingerprint({ ...card, undelivered: 1 })).not.toBe(fingerprint(card))
  })
})
