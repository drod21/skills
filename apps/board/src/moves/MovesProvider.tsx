// Moves for the whole board page. Two contexts: the actions (stable, so a card does not redraw while another is
// dragged) and the state (what a column or the status bar needs to draw a drag). The server decides every move; this
// only asks, shows the answer, and draws the card where it is going until the board confirms or refuses.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { OlderPage } from '../board/board-state'
import type { BoardCard, BoardView } from '../board/board-contract'
import { COLUMNS, type ColumnId } from '../board/columns'
import { beginGesture, type DragEnv } from './card-gesture'
import { fetchLookup, postMove } from './moves-client'
import type { MovesLookup, TargetId } from './moves-contract'
import {
  applyPending,
  initialMovesState,
  landingOf,
  moveCardOf,
  movesReducer,
  withoutCleared,
  type LookupState,
  type MoveCard,
  type MovesState,
} from './moves-state'
import { TARGET_LABEL, targetOfColumn } from './targets'

/** What the page offers a card: all of it works without a drag. */
export type MovesActions = {
  canMove: boolean
  /** Props for the card's `li`: the drag handle. */
  cardProps: (card: BoardCard) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onDragStart: (event: { preventDefault: () => void }) => void
    'data-movable': boolean
  }
  openMenu: (card: BoardCard) => void
  clearOne: (card: BoardCard) => void
  askClearAll: (column: 'done' | 'cancelled', cards: readonly BoardCard[]) => void
  confirmClearAll: () => void
  /** Choose a move from the menu. */
  choose: (card: MoveCard, target: TargetId, moves: MovesLookup) => void
  /** Send the text a move asked for. */
  submitForm: (inputs: Record<string, string>) => void
  closeSheet: () => void
  dismissNotice: () => void
  toggleCleared: () => void
  reconcile: (view: BoardView, older: OlderPage | null) => void
  /** The board page tells the moves which column is showing and how to change it. */
  registerColumns: (api: ColumnsApi | null) => void
}

export type ColumnsApi = { active: () => ColumnId; select: (id: ColumnId) => void }

const ActionsContext = createContext<MovesActions | null>(null)
const StateContext = createContext<MovesState>(initialMovesState)

/** Null outside the provider, so a card drawn somewhere else simply has no move controls. */
export const useMoves = () => useContext(ActionsContext)
export const useMovesState = () => useContext(StateContext)

/** The card under a press: what the board said it can do, once it has said, and whether it has lifted. */
type Held = { card: MoveCard; abort: AbortController; started: boolean; lookup: LookupState; lifted: boolean }

const switchesColumns = () => {
  const tabs = document.querySelector('.tabs')
  return tabs !== null && getComputedStyle(tabs).display !== 'none'
}

const describeFailure = (id: number, text: string) => `Task ${id}: ${text}`

export function MovesProvider({
  token,
  reload,
  children,
}: {
  token: string | null
  reload: () => void
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(movesReducer, initialMovesState)
  const live = useRef({ pending: state.pending, sheet: state.sheet })
  const columns = useRef<ColumnsApi | null>(null)
  const held = useRef<Held | null>(null)
  const keys = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    live.current = { pending: state.pending, sheet: state.sheet }
  }, [state.pending, state.sheet])

  const actions = useMemo<MovesActions>(() => {
    const enqueue = (job: () => Promise<void>) => {
      queue.current = queue.current.then(job).catch(() => undefined)
    }

    /** Do a legal move: draw it at once, ask the board, and undo the drawing if the board says no. */
    const send = (card: MoveCard, target: TargetId, command: string, inputs: Record<string, string>) => {
      if (token === null) return
      const landing = landingOf(command)
      const key = ++keys.current
      if (landing) dispatch({ type: 'pend', key, id: card.id, landing, at: Date.now() })
      enqueue(async () => {
        const outcome = await postMove(token, card.id, { target, revision: card.revision, inputs })
        if (outcome.ok) {
          dispatch({ type: 'confirmed', key, at: Date.now() })
          if (!landing) dispatch({ type: 'notice', tone: 'info', text: `Task ${card.id}: sent to the lead.` })
          return
        }
        dispatch({ type: 'failed', key: landing ? key : null, message: describeFailure(card.id, outcome.message) })
        // The card changed under the owner: show what it is now.
        if (outcome.kind === 'stale') reload()
      })
    }

    const lookupOf = async (card: MoveCard): Promise<MovesLookup | null> => {
      const result = await fetchLookup(card.id, new AbortController().signal)
      if (result.ok) return result.moves
      dispatch({ type: 'notice', tone: 'error', text: describeFailure(card.id, result.failure.message) })
      return null
    }

    /** Decide a move from the board's answer: refuse it in words, ask for its text, or send it. */
    const decide = (card: MoveCard, target: TargetId, moves: MovesLookup): 'sent' | 'asked' | 'refused' => {
      const option = moves.targets[target]
      if (option.state === 'here') {
        dispatch({ type: 'notice', tone: 'info', text: `Task ${card.id} is already ${TARGET_LABEL[target]}.` })
        return 'refused'
      }
      if (option.state === 'refused') {
        dispatch({
          type: 'notice',
          tone: 'error',
          text: `Task ${card.id} cannot go to ${TARGET_LABEL[target]}: ${option.reason}`,
        })
        return 'refused'
      }
      if (option.fields.length > 0) {
        dispatch({ type: 'sheet', sheet: { kind: 'form', card, target, option } })
        return 'asked'
      }
      send(card, target, option.command, {})
      return 'sent'
    }

    const clearCard = (card: MoveCard) => {
      if (token === null) return
      const key = ++keys.current
      dispatch({ type: 'pend', key, id: card.id, landing: { status: null, archive: true }, at: Date.now() })
      enqueue(async () => {
        const fail = (message: string) => dispatch({ type: 'failed', key, message: describeFailure(card.id, message) })
        const result = await fetchLookup(card.id, new AbortController().signal)
        if (!result.ok) return fail(result.failure.message)
        const option = result.moves.targets.clear
        if (option.state !== 'legal') return fail(option.state === 'refused' ? option.reason : 'it is not on the board')
        // The board clears finished work only. For live work its answer is a cancel, which is not a clear.
        if (option.command !== 'archive') return fail('it is not finished. Cancel it first, then clear it.')
        if (option.fields.some((field) => field.required)) return fail('clearing it needs a note. Use Move to.')
        const outcome = await postMove(token, card.id, { target: 'clear', revision: card.revision })
        if (outcome.ok) dispatch({ type: 'confirmed', key, at: Date.now() })
        else {
          fail(outcome.message)
          if (outcome.kind === 'stale') reload()
        }
      })
    }

    const endDrag = () => {
      held.current?.abort.abort()
      held.current = null
      dispatch({ type: 'dragEnd' })
    }

    /** Start asking the board what this card can do, so the answer is ready when the card lifts. */
    const prefetch = (current: Held) => {
      if (current.started) return
      current.started = true
      void fetchLookup(current.card.id, current.abort.signal).then(
        (result) => {
          if (held.current !== current) return
          current.lookup = result.ok
            ? { state: 'ready', moves: result.moves }
            : { state: 'failed', message: result.failure.message }
          if (current.lifted) dispatch({ type: 'dragLookup', id: current.card.id, lookup: current.lookup })
        },
        () => undefined,
      )
    }

    const gestureEnv = (current: Held): DragEnv => ({
      onLift: () => {
        current.lifted = true
        prefetch(current)
        dispatch({ type: 'dragStart', card: current.card })
        if (current.lookup.state !== 'loading') {
          dispatch({ type: 'dragLookup', id: current.card.id, lookup: current.lookup })
        }
      },
      onOver: (target) => dispatch({ type: 'dragOver', over: target }),
      onDwell: (spot) => {
        const api = columns.current
        if (!api || !switchesColumns()) return
        if ('column' in spot) {
          const next = COLUMNS.find((column) => column.id === spot.column)
          if (next) api.select(next.id)
          return
        }
        const from = COLUMNS.findIndex((column) => column.id === api.active())
        const next = COLUMNS[from + spot.side]
        if (next) api.select(next.id)
      },
      onDrop: (target) => {
        if (target === null) return 'return'
        if (current.lookup.state === 'ready') {
          const outcome = decide(current.card, target, current.lookup.moves)
          return outcome === 'sent' ? 'drop' : 'return'
        }
        // Dropped before the board answered: ask it now, then decide as usual.
        void lookupOf(current.card).then((moves) => {
          if (moves) decide(current.card, target, moves)
        })
        return 'return'
      },
      onEnd: endDrag,
    })

    return {
      canMove: token !== null,
      cardProps: (card) => ({
        'data-movable': token !== null,
        onDragStart: (event) => event.preventDefault(),
        onPointerDown: (event) => {
          if (token === null || event.button !== 0 || !event.isPrimary) return
          if (event.target instanceof Element && event.target.closest('button, input, select, textarea')) return
          if (live.current.pending.some((move) => move.id === card.id)) return
          held.current?.abort.abort()
          const current: Held = {
            card: moveCardOf(card),
            abort: new AbortController(),
            started: false,
            lookup: { state: 'loading' },
            lifted: false,
          }
          held.current = current
          // A finger rests before the card lifts, so the answer can arrive during the rest.
          if (event.pointerType !== 'mouse') prefetch(current)
          beginGesture(event.nativeEvent, event.currentTarget, gestureEnv(current))
        },
      }),
      openMenu: (card) => {
        const moveCard = moveCardOf(card)
        dispatch({ type: 'sheet', sheet: { kind: 'menu', card: moveCard, lookup: { state: 'loading' } } })
        void fetchLookup(card.id, new AbortController().signal).then((result) =>
          dispatch({
            type: 'sheetLookup',
            id: card.id,
            lookup: result.ok
              ? { state: 'ready', moves: result.moves }
              : { state: 'failed', message: result.failure.message },
          }),
        )
      },
      clearOne: (card) => clearCard(moveCardOf(card)),
      askClearAll: (column, cards) =>
        dispatch({ type: 'sheet', sheet: { kind: 'clearAll', column, cards: cards.map(moveCardOf) } }),
      confirmClearAll: () => {
        const sheet = live.current.sheet
        dispatch({ type: 'closeSheet' })
        if (sheet?.kind === 'clearAll') for (const card of sheet.cards) clearCard(card)
      },
      choose: (card, target, moves) => {
        dispatch({ type: 'closeSheet' })
        decide(card, target, moves)
      },
      submitForm: (inputs) => {
        const sheet = live.current.sheet
        dispatch({ type: 'closeSheet' })
        if (sheet?.kind === 'form') send(sheet.card, sheet.target, sheet.option.command, inputs)
      },
      closeSheet: () => dispatch({ type: 'closeSheet' }),
      dismissNotice: () => dispatch({ type: 'dismissNotice' }),
      toggleCleared: () => dispatch({ type: 'toggleCleared' }),
      reconcile: (view, older) => dispatch({ type: 'reconcile', view, older, at: Date.now() }),
      registerColumns: (api) => {
        columns.current = api
      },
    }
  }, [token, reload])

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  )
}

/**
 * The board as it should be drawn: the last good view with the moves in flight already done to it, and cleared cards
 * left out. The raw view is untouched; a failed move drops out of `pending` and the card is back where the board has it.
 */
export function useMovedBoard(view: BoardView, older: OlderPage | null) {
  const actions = useMoves()
  const { pending, showCleared } = useMovesState()
  const reconcile = actions?.reconcile
  useEffect(() => {
    reconcile?.(view, older)
  }, [view, older, reconcile])
  const moved = applyPending(view, older, pending)
  const shown = withoutCleared(moved.view, moved.older, showCleared)
  // `full` keeps the cleared cards: the closed totals are worked out from it.
  return { ...shown, full: moved, showCleared, hasCleared: moved.view.counts.archived > 0 }
}

/** What a column shows while a card is held over the board. */
export type DropState = {
  mark: 'idle' | 'none' | 'unknown' | 'here' | 'legal' | 'refused'
  over: boolean
  note: string | null
}

const IDLE: DropState = { mark: 'idle', over: false, note: null }

export function dropStateOf(drag: MovesState['drag'], target: TargetId | null): DropState {
  if (drag === null) return IDLE
  if (target === null) return { mark: 'none', over: false, note: null }
  const over = drag.over === target
  if (drag.lookup.state !== 'ready') return { mark: 'unknown', over, note: null }
  const option = drag.lookup.moves.targets[target]
  if (option.state === 'here') return { mark: 'here', over, note: null }
  if (option.state === 'refused') return { mark: 'refused', over, note: option.reason }
  return { mark: 'legal', over, note: null }
}

/** The attributes that make a column or its tab a drop target, and say what a drop there would do. */
export function dropAttrs(drag: MovesState['drag'], column: ColumnId) {
  const target = targetOfColumn(column)
  const drop = dropStateOf(drag, target)
  return {
    drop,
    props: {
      'data-drop-target': target ?? undefined,
      'data-drop-column': column,
      'data-drop': drop.mark,
      'data-over': drop.over,
    },
  }
}
