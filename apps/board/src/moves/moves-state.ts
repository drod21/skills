// What the page remembers about moves, as one pure reducer: moves in flight (drawn at once, undone if the board says
// no), the drag in progress, the open sheet, and the one notice on screen. `applyPending` lays the in-flight moves over
// the last good view so the columns show where a card is going; nothing here touches the DOM or the network.
import type { OlderPage } from '../board/board-state'
import type { BoardCard, BoardView } from '../board/board-contract'
import type { ClosedInfo } from '../board/columns'
import type { MoveOption, MovesLookup, TargetId } from './moves-contract'

/** How long a move the board accepted keeps its place while the next view is on its way. */
export const CONFIRM_HOLD_MS = 4_000

// ---- where a move lands

/** What a command does to the card: the status it ends in, and whether it leaves the board. Null: it moves nothing. */
export type Landing = { status: string | null; archive: boolean }

export function landingOf(command: string): Landing | null {
  switch (command) {
    case 'release':
      return { status: 'open', archive: false }
    case 'cancel':
      // Only `archive` leaves the board. A cancel, whichever target asked for it, ends in Cancelled.
      return { status: 'cancelled', archive: false }
    case 'done':
      return { status: 'done', archive: false }
    case 'archive':
      return { status: null, archive: true }
    default:
      // A note to the lead (start, reopen) changes nothing on the board by itself.
      return null
  }
}

// ---- what is on screen besides the columns

/** The card a move or a sheet is about, as the page saw it when the owner reached for it. */
export type MoveCard = { id: number; title: string | null; status: string; owner: string | null; revision: string }

export const moveCardOf = (card: BoardCard): MoveCard => ({
  id: card.id,
  title: card.title,
  status: card.status,
  owner: card.owner,
  revision: card.reviewRevision,
})

export type LookupState =
  | { state: 'loading' }
  | { state: 'ready'; moves: MovesLookup }
  | { state: 'failed'; message: string }

export type Drag = { card: MoveCard; lookup: LookupState; over: TargetId | null }

export type Sheet =
  | { kind: 'menu'; card: MoveCard; lookup: LookupState }
  | { kind: 'form'; card: MoveCard; target: TargetId; option: Extract<MoveOption, { state: 'legal' }> }
  | { kind: 'clearAll'; column: 'done' | 'cancelled'; cards: readonly MoveCard[] }

export type Notice = { key: number; tone: 'error' | 'info'; text: string }

export type Pending = { key: number; id: number; landing: Landing; phase: 'sending' | 'confirmed'; since: number }

export type MovesState = {
  pending: readonly Pending[]
  notice: Notice | null
  drag: Drag | null
  sheet: Sheet | null
  showCleared: boolean
  nextKey: number
}

export const initialMovesState: MovesState = {
  pending: [],
  notice: null,
  drag: null,
  sheet: null,
  showCleared: false,
  nextKey: 1,
}

export type MovesAction =
  | { type: 'pend'; key: number; id: number; landing: Landing; at: number }
  | { type: 'confirmed'; key: number; at: number }
  | { type: 'failed'; key: number | null; message: string }
  | { type: 'reconcile'; view: BoardView; older: OlderPage | null; at: number }
  | { type: 'notice'; tone: Notice['tone']; text: string }
  | { type: 'dismissNotice' }
  | { type: 'dragStart'; card: MoveCard }
  | { type: 'dragLookup'; id: number; lookup: LookupState }
  | { type: 'dragOver'; over: TargetId | null }
  | { type: 'dragEnd' }
  | { type: 'sheet'; sheet: Sheet }
  | { type: 'sheetLookup'; id: number; lookup: LookupState }
  | { type: 'closeSheet' }
  | { type: 'toggleCleared' }

// The reducer is four small ones in a row, each owning one slice and handing every other action back untouched.

function pendingReducer(state: MovesState, action: MovesAction): MovesState {
  switch (action.type) {
    case 'pend':
      return {
        ...state,
        pending: [
          ...state.pending,
          { key: action.key, id: action.id, landing: action.landing, phase: 'sending', since: action.at },
        ],
      }
    case 'confirmed':
      return {
        ...state,
        pending: state.pending.map((p) => (p.key === action.key ? { ...p, phase: 'confirmed', since: action.at } : p)),
      }
    case 'failed':
      // Taking the move out of `pending` is the rollback: the next render draws the card where the board has it.
      return {
        ...state,
        nextKey: state.nextKey + 1,
        pending: state.pending.filter((p) => p.key !== action.key),
        notice: { key: state.nextKey, tone: 'error', text: action.message },
      }
    case 'reconcile': {
      const keep = state.pending.filter(
        (p) =>
          p.phase === 'sending' || (!landed(action.view, action.older, p) && action.at - p.since < CONFIRM_HOLD_MS),
      )
      return keep.length === state.pending.length ? state : { ...state, pending: keep }
    }
    default:
      return state
  }
}

function noticeReducer(state: MovesState, action: MovesAction): MovesState {
  switch (action.type) {
    case 'notice':
      return {
        ...state,
        nextKey: state.nextKey + 1,
        notice: { key: state.nextKey, tone: action.tone, text: action.text },
      }
    case 'dismissNotice':
      return state.notice === null ? state : { ...state, notice: null }
    case 'toggleCleared':
      return { ...state, showCleared: !state.showCleared }
    default:
      return state
  }
}

function dragReducer(state: MovesState, action: MovesAction): MovesState {
  const { drag } = state
  switch (action.type) {
    case 'dragStart':
      return { ...state, drag: { card: action.card, lookup: { state: 'loading' }, over: null }, sheet: null }
    case 'dragLookup':
      return drag && drag.card.id === action.id ? { ...state, drag: { ...drag, lookup: action.lookup } } : state
    case 'dragOver':
      return drag && drag.over !== action.over ? { ...state, drag: { ...drag, over: action.over } } : state
    case 'dragEnd':
      return drag ? { ...state, drag: null } : state
    default:
      return state
  }
}

function sheetReducer(state: MovesState, action: MovesAction): MovesState {
  const { sheet } = state
  switch (action.type) {
    case 'sheet':
      return { ...state, sheet: action.sheet }
    case 'sheetLookup':
      return sheet?.kind === 'menu' && sheet.card.id === action.id
        ? { ...state, sheet: { ...sheet, lookup: action.lookup } }
        : state
    case 'closeSheet':
      return sheet ? { ...state, sheet: null } : state
    default:
      return state
  }
}

export function movesReducer(state: MovesState, action: MovesAction): MovesState {
  return sheetReducer(dragReducer(noticeReducer(pendingReducer(state, action), action), action), action)
}

// ---- the optimistic overlay

type Lists = { tasks: BoardCard[]; closed: BoardCard[]; older: BoardCard[] | null }

const CLOSED = ['done', 'cancelled']
const COUNTED = ['open', 'claimed', 'done', 'cancelled'] as const
type Counted = (typeof COUNTED)[number]
const isCounted = (status: string): status is Counted => COUNTED.some((counted) => counted === status)

function findCard(lists: Lists, id: number): BoardCard | undefined {
  return (
    lists.tasks.find((card) => card.id === id) ??
    lists.closed.find((card) => card.id === id) ??
    lists.older?.find((card) => card.id === id)
  )
}

type Counts = BoardView['counts']

/** The card as the move leaves it: the new status, no owner once released, archived once cleared. */
function movedCard(card: BoardCard, landing: Landing): BoardCard {
  const status = landing.status ?? card.status
  return {
    ...card,
    status,
    owner: status === 'open' && card.status !== 'open' ? null : card.owner,
    archived: card.archived || landing.archive,
  }
}

function recount(counts: Counts, from: BoardCard, to: BoardCard): void {
  if (from.status !== to.status) {
    if (isCounted(from.status)) counts[from.status] -= 1
    if (isCounted(to.status)) counts[to.status] += 1
  }
  if (!from.archived && to.archived) counts.archived += 1
}

function mapLists(lists: Lists, change: (list: BoardCard[]) => BoardCard[]): Lists {
  return { tasks: change(lists.tasks), closed: change(lists.closed), older: lists.older && change(lists.older) }
}

/** Where the moved card goes: in place for a clear, otherwise out of every list and to the front of its new one. */
function place(lists: Lists, from: BoardCard, moved: BoardCard): Lists {
  if (from.status === moved.status) return mapLists(lists, (list) => list.map((c) => (c.id === moved.id ? moved : c)))
  const rest = mapLists(lists, (list) => list.filter((c) => c.id !== moved.id))
  // A card that just closed leads the closed list, as the board's newest-first order would put it.
  return CLOSED.includes(moved.status)
    ? { ...rest, closed: [moved, ...rest.closed] }
    : { ...rest, tasks: [...rest.tasks, moved] }
}

/** The view with every move in flight already done to it. The input is never changed. */
export function applyPending(
  view: BoardView,
  older: OlderPage | null,
  pending: readonly Pending[],
): { view: BoardView; older: OlderPage | null } {
  if (pending.length === 0) return { view, older }
  let lists: Lists = { tasks: view.tasks, closed: view.closed.tasks, older: older?.tasks ?? null }
  const counts = { ...view.counts }
  for (const move of pending) {
    const card = findCard(lists, move.id)
    if (!card) continue
    const moved = movedCard(card, move.landing)
    recount(counts, card, moved)
    lists = place(lists, card, moved)
  }
  return {
    view: { ...view, counts, tasks: lists.tasks, closed: { ...view.closed, tasks: lists.closed } },
    older: older && lists.older ? { ...older, tasks: lists.older } : older,
  }
}

/** Whether the board's own view already shows the card where the move put it. */
export function landed(view: BoardView, older: OlderPage | null, move: Pending): boolean {
  const card = findCard({ tasks: view.tasks, closed: view.closed.tasks, older: older?.tasks ?? null }, move.id)
  if (!card) return move.landing.archive
  const statusDone = move.landing.status === null || card.status === move.landing.status
  return statusDone && (!move.landing.archive || card.archived)
}

// ---- cleared cards

/** The closed lists without the cards that were cleared: they left the board, so they leave the columns. */
export function withoutCleared(
  view: BoardView,
  older: OlderPage | null,
  showCleared: boolean,
): { view: BoardView; older: OlderPage | null } {
  if (showCleared) return { view, older }
  const keep = (card: BoardCard) => !card.archived
  return {
    view: { ...view, closed: { ...view.closed, tasks: view.closed.tasks.filter(keep) } },
    older: older ? { ...older, tasks: older.tasks.filter(keep) } : older,
  }
}

/**
 * The closed numbers once cleared cards are hidden. The board's counts include cleared tasks, so a total is only
 * known when every cleared task has been seen; until then the column shows what is loaded, with a plus.
 */
export function closedInfoWithoutCleared(
  info: ClosedInfo,
  view: BoardView,
  older: OlderPage | null,
  showCleared: boolean,
): ClosedInfo {
  if (showCleared || info.totals === null || view.counts.archived === 0) return info
  const seen = [...view.closed.tasks, ...(older?.tasks ?? [])].filter((card) => card.archived)
  const ids = new Set(seen.map((card) => card.id))
  if (ids.size !== view.counts.archived) return { ...info, totals: null }
  const archivedIn = (status: 'done' | 'cancelled') =>
    [...ids].filter(
      (id) => [...view.closed.tasks, ...(older?.tasks ?? [])].find((card) => card.id === id)?.status === status,
    ).length
  return {
    ...info,
    totals: {
      done: info.totals.done - archivedIn('done'),
      cancelled: info.totals.cancelled - archivedIn('cancelled'),
    },
  }
}
