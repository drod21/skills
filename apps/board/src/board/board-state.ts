// Everything the page remembers about the board, as one reducer: the last good view, older closed pages, whether the
// live stream is up, and which cards just changed. Pure, so a test can drive it through a reconnect or a failed read.
import type { BoardCard, BoardFailure, BoardView } from './board-contract'
import { fingerprint, mergeClosed } from './columns'

/** A view is stale when the stream is not carrying updates and the last good read is older than this. */
export const STALE_AFTER_MS = 30_000

export type Snapshot =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: BoardFailure }
  | { kind: 'ready'; view: BoardView; fetchedAt: number; readError: BoardFailure | null }

export type StreamStatus = 'connecting' | 'open' | 'down'
export type OlderPage = { tasks: BoardCard[]; next: string | null }
/** Every value the filters can offer, collected from each view seen so a filter does not lose its choices. */
export type Options = { roles: string[]; tags: string[]; owners: string[] }

export type BoardState = {
  snapshot: Snapshot
  /** Closed cards past the first page, with the cursor for the next; null until "Load older" is used. */
  older: OlderPage | null
  stream: StreamStatus
  /** Fingerprints of the last view's cards, to find which changed; null when there is nothing to compare to. */
  fingerprints: ReadonlyMap<number, string> | null
  /** Ids that changed in the last view, shown for a moment so the eye finds them. */
  changed: ReadonlySet<number>
  options: Options
}

export type BoardAction =
  | { type: 'viewLoaded'; view: BoardView; at: number }
  | { type: 'viewFailed'; failure: BoardFailure }
  | { type: 'olderLoaded'; page: OlderPage }
  | { type: 'queryChanged' }
  | { type: 'stream'; status: StreamStatus }
  | { type: 'settled' }

export const initialBoardState: BoardState = {
  snapshot: { kind: 'loading' },
  older: null,
  stream: 'connecting',
  fingerprints: null,
  changed: new Set(),
  options: { roles: [], tags: [], owners: [] },
}

const fingerprintsOf = (view: BoardView): Map<number, string> =>
  new Map([...view.tasks, ...view.closed.tasks].map((card) => [card.id, fingerprint(card)]))

/** Ids that are new or differ from the last view. */
function changedIds(before: ReadonlyMap<number, string> | null, after: ReadonlyMap<number, string>): Set<number> {
  if (before === null) return new Set()
  return new Set([...after].filter(([id, print]) => before.get(id) !== print).map(([id]) => id))
}

const union = (known: readonly string[], found: readonly (string | null)[]): string[] =>
  [...new Set([...known, ...found.filter((value) => value !== null)])].toSorted((a, b) => a.localeCompare(b))

function withOptions(options: Options, cards: readonly BoardCard[]): Options {
  return {
    roles: union(
      options.roles,
      cards.map((card) => card.role),
    ),
    tags: union(
      options.tags,
      cards.map((card) => card.tag),
    ),
    owners: union(
      options.owners,
      cards.map((card) => card.owner),
    ),
  }
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case 'viewLoaded': {
      const next = fingerprintsOf(action.view)
      return {
        ...state,
        snapshot: { kind: 'ready', view: action.view, fetchedAt: action.at, readError: null },
        fingerprints: next,
        changed: changedIds(state.fingerprints, next),
        options: withOptions(state.options, [...action.view.tasks, ...action.view.closed.tasks]),
      }
    }
    case 'viewFailed':
      // A failed read keeps the last good view and says so; with none yet, the failure is all there is to show.
      return state.snapshot.kind === 'ready'
        ? { ...state, snapshot: { ...state.snapshot, readError: action.failure } }
        : { ...state, snapshot: { kind: 'failed', failure: action.failure } }
    case 'olderLoaded': {
      const known = state.older?.tasks ?? []
      return {
        ...state,
        older: { tasks: mergeClosed(known, action.page.tasks), next: action.page.next },
        options: withOptions(state.options, action.page.tasks),
      }
    }
    case 'queryChanged':
      return { ...state, older: null, fingerprints: null, changed: new Set() }
    case 'stream':
      return { ...state, stream: action.status }
    case 'settled':
      return state.changed.size === 0 ? state : { ...state, changed: new Set() }
  }
}

/** The cursor for the next closed page, or null when everything is loaded. */
export function closedCursor(state: BoardState): string | null {
  if (state.older) return state.older.next
  return state.snapshot.kind === 'ready' ? state.snapshot.view.closed.next : null
}

/** What the header says about the data: how fresh it is and what keeps it fresh. */
export type Connection = 'connecting' | 'live' | 'polling' | 'stale'

export function connectionOf(state: BoardState, nowMs: number): Connection {
  const { snapshot, stream } = state
  if (snapshot.kind === 'loading') return 'connecting'
  if (snapshot.kind === 'failed' || snapshot.readError !== null) return 'stale'
  if (stream === 'open') return 'live'
  if (nowMs - snapshot.fetchedAt > STALE_AFTER_MS) return 'stale'
  return stream === 'connecting' ? 'connecting' : 'polling'
}
