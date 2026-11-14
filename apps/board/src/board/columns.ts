// The board's five columns and the rules that fill them from one `view`. Pure: the page gives it the view, the older
// closed pages it has loaded and the text filter; it gives back what each column shows.
import type { BoardCard, BoardView, LeadRow, NeedsReason, NeedsRow } from './board-contract'
import { ownerLabel } from './format'

export type ColumnId = 'needs' | 'open' | 'progress' | 'done' | 'cancelled'

/** The columns in reading order, with the words each one uses. The only place a column is named. */
export const COLUMNS: readonly { id: ColumnId; title: string; empty: string }[] = [
  { id: 'needs', title: 'Needs me', empty: 'Nothing is waiting on you.' },
  { id: 'open', title: 'Open', empty: 'No open tasks match.' },
  { id: 'progress', title: 'In progress', empty: 'Nothing is claimed right now.' },
  { id: 'done', title: 'Done', empty: 'No finished tasks match.' },
  { id: 'cancelled', title: 'Cancelled', empty: 'No cancelled tasks match.' },
]

const KNOWN_STATUSES: readonly string[] = ['open', 'claimed', 'done', 'cancelled']
/** False for a status the CLI added after this app was built; the card then names it in plain text. */
export const isKnownStatus = (status: string) => KNOWN_STATUSES.includes(status)

/** The column the phone opens on: what needs the owner comes first. */
export const FIRST_COLUMN: ColumnId = 'needs'

/** An empty string means "any". Role, tag and owner narrow what the server returns; text narrows what is shown. */
export type Filters = { role: string; tag: string; owner: string; text: string }
export type ServerFilters = Pick<Filters, 'role' | 'tag' | 'owner'>
export const NO_FILTERS: Filters = { role: '', tag: '', owner: '', text: '' }
export const isFiltered = (filters: Filters) => Object.values(filters).some((value) => value !== '')

export type BuiltColumns = {
  /** `rows` is what the owner can act on and what the tab counts; `rejected` is the quiet record of rejected checks. */
  needs: { rows: NeedsRow[]; rejected: NeedsRow[]; lead: LeadRow[] }
  open: BoardCard[]
  progress: BoardCard[]
  done: BoardCard[]
  cancelled: BoardCard[]
}

const terms = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean)
const matchesAll = (haystack: string, wanted: string[]) => wanted.every((term) => haystack.includes(term))

function cardText(card: BoardCard): string {
  const parts = [`#${card.id}`, String(card.id), card.title, card.role, card.tag, card.route]
  if (card.owner !== null) parts.push(ownerLabel(card.owner))
  return parts
    .filter((part) => part !== null)
    .join(' ')
    .toLowerCase()
}

function needsText(row: NeedsRow | LeadRow): string {
  const reasons =
    'reasons' in row
      ? row.reasons.map((reason) => (reason.why === 'question' ? reason.text : reason.why)).join(' ')
      : (row.text ?? '')
  return [`#${row.id}`, String(row.id), row.title ?? '', reasons].join(' ').toLowerCase()
}

/**
 * How soon the owner should look at a reason: a question, then a held check, then a stuck message. A rejected check
 * is listed for the record but asks nothing of the owner, so it is not counted and is drawn quiet.
 */
const REASON_RANK: Record<NeedsReason['why'], number> = { question: 0, hold: 1, delivery: 2, other: 2, rejected: 3 }

export const asksOwner = (reason: NeedsReason) => reason.why !== 'rejected'

const rankOf = (row: NeedsRow) => Math.min(...row.reasons.map((reason) => REASON_RANK[reason.why]))

/** A row the owner can act on: at least one reason that asks something of them. */
const asksSomething = (row: NeedsRow) => row.reasons.some(asksOwner)

/** The most urgent reason first, the board's order within a rank. */
const byOwnerAction = (a: NeedsRow, b: NeedsRow) => rankOf(a) - rankOf(b)

/** The first page of closed cards followed by the older pages, once each. */
export function mergeClosed(first: readonly BoardCard[], older: readonly BoardCard[]): BoardCard[] {
  const seen = new Set(first.map((card) => card.id))
  return [...first, ...older.filter((card) => !seen.has(card.id))]
}

/** Most recent sign of life first; a claim nobody has heard from sorts after one somebody has. */
const byRecentSignal = (a: BoardCard, b: BoardCard) => {
  const timeOf = (card: BoardCard) => Date.parse(card.lastSignalAt ?? card.claimedAt ?? '') || 0
  return timeOf(b) - timeOf(a) || b.id - a.id
}

export function buildColumns(view: BoardView, older: readonly BoardCard[], text: string): BuiltColumns {
  const wanted = terms(text)
  const keep = (card: BoardCard) => wanted.length === 0 || matchesAll(cardText(card), wanted)
  const keepRow = (row: NeedsRow | LeadRow) => wanted.length === 0 || matchesAll(needsText(row), wanted)
  const closed = mergeClosed(view.closed.tasks, older).filter(keep)
  const live = view.tasks.filter(keep)
  return {
    needs: {
      rows: view.needsOwner.filter(keepRow).filter(asksSomething).toSorted(byOwnerAction),
      rejected: view.needsOwner.filter(keepRow).filter((row) => !asksSomething(row)),
      lead: view.withLead.filter(keepRow),
    },
    // A status the CLI adds later has no column of its own yet: live work waits in Open, finished work sits in Done.
    open: live.filter((card) => card.status !== 'claimed').toSorted((a, b) => a.id - b.id),
    progress: live.filter((card) => card.status === 'claimed').toSorted(byRecentSignal),
    done: closed.filter((card) => card.status !== 'cancelled'),
    cancelled: closed.filter((card) => card.status === 'cancelled'),
  }
}

/** What decides the closed columns' numbers: whether older pages remain, and the board's own totals when unfiltered. */
export type ClosedInfo = { hasMore: boolean; totals: Record<'done' | 'cancelled', number> | null }

/** The closed totals to show: the board's own counts when nothing narrows the list, else none. */
export function closedInfo(view: BoardView, filters: Filters, hasMore: boolean): ClosedInfo {
  return { hasMore, totals: isFiltered(filters) ? null : { done: view.counts.done, cancelled: view.counts.cancelled } }
}

/**
 * The number a tab shows. Closed columns show the board's total when nothing is filtered; once a filter narrows
 * them, only what is loaded is known, so they show that with a plus while older pages remain.
 */
export function columnCount(id: ColumnId, built: BuiltColumns, closed: ClosedInfo): { value: number; more: boolean } {
  switch (id) {
    case 'needs':
      return { value: built.needs.rows.length, more: false }
    case 'open':
    case 'progress':
      return { value: built[id].length, more: false }
    case 'done':
    case 'cancelled':
      return closed.totals
        ? { value: closed.totals[id], more: false }
        : { value: built[id].length, more: closed.hasMore }
  }
}

export const countLabel = ({ value, more }: { value: number; more: boolean }) => `${value}${more ? '+' : ''}`

/** What changing one card changes on screen. `lastSignalAt` is left out: every heartbeat would flash the card. */
export const fingerprint = (card: BoardCard): string =>
  JSON.stringify([
    card.title,
    card.status,
    card.role,
    card.tag,
    card.owner,
    card.gated,
    card.silent,
    card.undelivered,
    card.ownerThread,
    card.waitsOn,
  ])
