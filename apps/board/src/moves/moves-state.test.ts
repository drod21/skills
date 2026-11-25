import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import raw from '../../tests/fixtures/view.json'
import { BoardViewSchema, type BoardCard, type BoardView } from '../board/board-contract'
import { buildColumns, closedInfo, NO_FILTERS } from '../board/columns'
import {
  CONFIRM_HOLD_MS,
  applyPending,
  closedInfoWithoutCleared,
  initialMovesState,
  landed,
  landingOf,
  movesReducer,
  withoutCleared,
  type MovesState,
  type Pending,
} from './moves-state'

const checked = BoardViewSchema.safeParse(structuredClone(raw))
if (!checked.success) throw new Error(z.prettifyError(checked.error))
const parsed: BoardView = checked.data
const base: BoardCard = parsed.tasks[0] ?? parsed.closed.tasks[0]!

const card = (id: number, status: string, change: Partial<BoardCard> = {}): BoardCard => ({
  ...base,
  id,
  status,
  owner: status === 'claimed' ? 'worker' : null,
  archived: false,
  ...change,
})

function viewOf(tasks: BoardCard[], closed: BoardCard[]): BoardView {
  const count = (status: string) => [...tasks, ...closed].filter((c) => c.status === status).length
  return {
    ...parsed,
    tasks,
    closed: { ...parsed.closed, tasks: closed, next: null },
    needsOwner: [],
    withLead: [],
    counts: {
      open: count('open'),
      claimed: count('claimed'),
      done: count('done'),
      cancelled: count('cancelled'),
      archived: closed.filter((c) => c.archived).length,
    },
  }
}

const move = (id: number, command: string, at = 0): Pending => {
  const landing = landingOf(command)
  if (!landing) throw new Error('no landing')
  return { key: id, id, landing, phase: 'sending', since: at }
}

describe('landingOf', () => {
  it('knows where release, cancel, done and archive end up, and that a note moves nothing', () => {
    expect(landingOf('release')).toEqual({ status: 'open', archive: false })
    expect(landingOf('cancel')).toEqual({ status: 'cancelled', archive: false })
    expect(landingOf('done')).toEqual({ status: 'done', archive: false })
    expect(landingOf('archive')).toEqual({ status: null, archive: true })
    expect(landingOf('note')).toBeNull()
    expect(landingOf('something-new')).toBeNull()
  })

  it('shows a cancel as Cancelled, never as cleared: only archive leaves the board', () => {
    // The Clear target on a task that is not finished runs `cancel`; the board keeps the card in Cancelled.
    const view = viewOf([card(1, 'claimed')], [])
    const { view: next } = applyPending(view, null, [move(1, 'cancel')])
    expect(next.tasks.map((task) => task.id)).toEqual([])
    expect(next.closed.tasks.map((task) => [task.id, task.status, task.archived])).toEqual([[1, 'cancelled', false]])
  })
})

describe('applyPending', () => {
  const view = viewOf([card(1, 'claimed'), card(2, 'open')], [card(3, 'done'), card(4, 'cancelled')])

  it('changes nothing when nothing is in flight', () => {
    expect(applyPending(view, null, []).view).toBe(view)
  })

  it('moves a released card to Open and clears its owner, without touching the input', () => {
    const before = structuredClone(view)
    const { view: next } = applyPending(view, null, [move(1, 'release')])
    const columns = buildColumns(next, [], '')
    expect(columns.open.map((c) => c.id)).toEqual([1, 2])
    expect(columns.progress).toEqual([])
    expect(next.tasks.find((c) => c.id === 1)?.owner).toBeNull()
    expect(next.counts).toMatchObject({ open: 2, claimed: 0 })
    expect(view).toEqual(before)
  })

  it('moves a cancelled card out of the live list and to the front of Cancelled', () => {
    const { view: next } = applyPending(view, null, [move(1, 'cancel')])
    expect(next.tasks.map((c) => c.id)).toEqual([2])
    expect(buildColumns(next, [], '').cancelled.map((c) => c.id)).toEqual([1, 4])
    expect(next.counts).toMatchObject({ claimed: 0, cancelled: 2 })
  })

  it('marks a cleared card archived in place and counts it', () => {
    const { view: next } = applyPending(view, null, [move(3, 'archive')])
    expect(next.closed.tasks.find((c) => c.id === 3)).toMatchObject({ status: 'done', archived: true })
    expect(next.counts.archived).toBe(1)
    expect(next.counts.done).toBe(1)
  })

  it('moves a card found only in the older pages', () => {
    const older = { tasks: [card(9, 'done')], next: null }
    const result = applyPending(view, older, [move(9, 'archive')])
    expect(result.older?.tasks[0]?.archived).toBe(true)
  })

  it('ignores a move for a card that is gone', () => {
    expect(applyPending(view, null, [move(77, 'release')]).view.tasks).toEqual(view.tasks)
  })
})

describe('landed', () => {
  it('is true once the board shows the card where the move put it', () => {
    const after = viewOf([card(1, 'open')], [])
    expect(landed(after, null, move(1, 'release'))).toBe(true)
    expect(landed(viewOf([card(1, 'claimed')], []), null, move(1, 'release'))).toBe(false)
  })

  it('counts a cleared card that left the view as landed', () => {
    expect(landed(viewOf([], []), null, move(5, 'archive'))).toBe(true)
    expect(landed(viewOf([], [card(5, 'done')]), null, move(5, 'archive'))).toBe(false)
  })
})

describe('movesReducer', () => {
  const pend = (state: MovesState, id: number): MovesState =>
    movesReducer(state, { type: 'pend', key: id, id, landing: { status: 'open', archive: false }, at: 0 })

  it('puts a failed move back and says why', () => {
    const started = pend(initialMovesState, 1)
    const key = started.pending[0]?.key ?? -1
    const failed = movesReducer(started, { type: 'failed', key, message: 'a done task cannot be cancelled' })
    expect(failed.pending).toEqual([])
    expect(failed.notice).toMatchObject({ tone: 'error', text: 'a done task cannot be cancelled' })
  })

  it('keeps a sending move through a reconcile, then drops a confirmed one that landed', () => {
    const after = viewOf([card(1, 'open')], [])
    const started = pend(initialMovesState, 1)
    const key = started.pending[0]?.key ?? -1
    expect(movesReducer(started, { type: 'reconcile', view: after, older: null, at: 1 }).pending).toHaveLength(1)
    const confirmed = movesReducer(started, { type: 'confirmed', key, at: 10 })
    expect(movesReducer(confirmed, { type: 'reconcile', view: after, older: null, at: 11 }).pending).toEqual([])
  })

  it('drops a confirmed move whose view never arrives after the hold', () => {
    const stale = viewOf([card(1, 'claimed')], [])
    const started = pend(initialMovesState, 1)
    const key = started.pending[0]?.key ?? -1
    const confirmed = movesReducer(started, { type: 'confirmed', key, at: 10 })
    expect(movesReducer(confirmed, { type: 'reconcile', view: stale, older: null, at: 11 }).pending).toHaveLength(1)
    const late = movesReducer(confirmed, { type: 'reconcile', view: stale, older: null, at: 10 + CONFIRM_HOLD_MS })
    expect(late.pending).toEqual([])
  })

  it('tracks a drag, ignores a lookup for another card, and ends it', () => {
    const moveCard = { id: 1, title: 't', status: 'claimed', owner: 'worker-ux', revision: 'r' }
    const dragging = movesReducer(initialMovesState, { type: 'dragStart', card: moveCard })
    expect(dragging.drag?.lookup).toEqual({ state: 'loading' })
    const other = movesReducer(dragging, { type: 'dragLookup', id: 2, lookup: { state: 'failed', message: 'x' } })
    expect(other.drag?.lookup).toEqual({ state: 'loading' })
    const over = movesReducer(dragging, { type: 'dragOver', over: 'cancelled' })
    expect(over.drag?.over).toBe('cancelled')
    expect(movesReducer(over, { type: 'dragEnd' }).drag).toBeNull()
  })
})

describe('cleared cards', () => {
  const closed = [card(3, 'done'), card(4, 'cancelled', { archived: true }), card(5, 'done', { archived: true })]
  const view = viewOf([card(1, 'open')], closed)

  it('hides them unless asked, in both closed lists', () => {
    const hidden = withoutCleared(
      view,
      { tasks: [card(6, 'done', { archived: true }), card(7, 'done')], next: null },
      false,
    )
    expect(hidden.view.closed.tasks.map((c) => c.id)).toEqual([3])
    expect(hidden.older?.tasks.map((c) => c.id)).toEqual([7])
    expect(withoutCleared(view, null, true).view).toBe(view)
  })

  it('subtracts the cleared cards from the totals once every one has been seen', () => {
    const info = closedInfo(view, NO_FILTERS, false)
    expect(info.totals).toEqual({ done: 2, cancelled: 1 })
    expect(closedInfoWithoutCleared(info, view, null, false).totals).toEqual({ done: 1, cancelled: 0 })
  })

  it('shows no total while a cleared card is still on an unloaded page', () => {
    const more = { ...view, counts: { ...view.counts, archived: 3 } }
    const info = closedInfo(more, NO_FILTERS, true)
    expect(closedInfoWithoutCleared(info, more, null, false).totals).toBeNull()
  })

  it('leaves the totals alone when nothing was ever cleared', () => {
    const plain = viewOf([], [card(3, 'done')])
    const info = closedInfo(plain, NO_FILTERS, false)
    expect(closedInfoWithoutCleared(info, plain, null, false)).toBe(info)
  })
})
