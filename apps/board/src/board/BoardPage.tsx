// The board: a switcher of columns on a phone, all the columns side by side on a desktop. Both are the same markup;
// CSS decides which columns show. It renders the last good view whatever the connection is doing.
import { type KeyboardEvent, useDeferredValue, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ColumnTools } from '../moves/ColumnTools'
import { DragLayer } from '../moves/DragLayer'
import { MoveSheet } from '../moves/MoveSheet'
import { MovesProvider, dropAttrs, useMoves, useMovedBoard, useMovesState } from '../moves/MovesProvider'
import { closedCursor, connectionOf, type BoardState } from './board-state'
import type { BoardFailure } from './board-contract'
import {
  COLUMNS,
  FIRST_COLUMN,
  buildColumns,
  closedInfo,
  columnCount,
  countLabel,
  type BuiltColumns,
  type ClosedInfo,
  type ColumnId,
  type Filters,
} from './columns'
import { closedInfoWithoutCleared } from '../moves/moves-state'
import { FilterBar } from './FilterBar'
import { clockLabel } from './format'
import { Header } from './Header'
import { LeadCard, NeedsCard } from './NeedsCard'
import { TaskCard } from './TaskCard'
import { useBoard, useNow, useSession, type OlderStatus } from './use-board'

function ReadBanner({
  failure,
  lastReadAt,
  onRetry,
}: {
  failure: BoardFailure
  lastReadAt: number | null
  onRetry: () => void
}) {
  return (
    <div className='banner' role='alert'>
      <p>
        Cannot read the board: {failure.message}.{' '}
        {lastReadAt === null ? '' : `Showing the view from ${clockLabel(lastReadAt)}.`}
      </p>
      <button type='button' className='button' onClick={onRetry}>
        <RefreshCw aria-hidden='true' />
        <span>Retry</span>
      </button>
    </div>
  )
}

function OlderButton({ status, onLoad }: { status: OlderStatus; onLoad: () => void }) {
  return (
    <li>
      <button type='button' className='button' data-wide='true' disabled={status === 'loading'} onClick={onLoad}>
        {status === 'loading'
          ? 'Loading older tasks'
          : status === 'failed'
            ? 'Could not load older tasks. Try again'
            : 'Load older'}
      </button>
    </li>
  )
}

type BodyProps = {
  id: ColumnId
  built: BuiltColumns
  nowMs: number
  changed: ReadonlySet<number>
  closedHasMore: boolean
  olderStatus: OlderStatus
  onLoadOlder: () => void
  empty: string
}

/** A closed column that is empty may only be empty so far: its tasks can sit on an older page. */
const NOT_LOADED_YET = 'None in the newest tasks. Load older to look further back.'

function ColumnBody({ id, built, nowMs, changed, closedHasMore, olderStatus, onLoadOlder, empty }: BodyProps) {
  if (id === 'needs') {
    const { rows, rejected, lead } = built.needs
    return (
      <ul className='list'>
        {rows.length === 0 && <li className='empty'>{empty}</li>}
        {rows.map((row) => (
          <NeedsCard key={row.id} row={row} />
        ))}
        {rejected.length > 0 && (
          <>
            <li className='group-title' data-group='rejected'>
              Rejected checks <span className='num'>{rejected.length}</span>
            </li>
            {rejected.map((row) => (
              <NeedsCard key={row.id} row={row} />
            ))}
          </>
        )}
        {lead.length > 0 && (
          <>
            <li className='group-title'>Waiting on the lead</li>
            {lead.map((row) => (
              <LeadCard key={row.id} row={row} />
            ))}
          </>
        )}
      </ul>
    )
  }
  const cards = built[id]
  const closed = id === 'done' || id === 'cancelled'
  return (
    <ul className='list'>
      {cards.length === 0 && <li className='empty'>{closed && closedHasMore ? NOT_LOADED_YET : empty}</li>}
      {cards.map((card) => (
        <TaskCard key={card.id} card={card} nowMs={nowMs} changed={changed.has(card.id)} />
      ))}
      {closed && closedHasMore && <OlderButton status={olderStatus} onLoad={onLoadOlder} />}
    </ul>
  )
}

function Tabs({
  built,
  closed,
  active,
  onSelect,
}: {
  built: BuiltColumns
  closed: ClosedInfo
  active: ColumnId
  onSelect: (id: ColumnId) => void
}) {
  const { drag } = useMovesState()
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = COLUMNS[(from + step + COLUMNS.length) % COLUMNS.length]
    if (!next) return
    onSelect(next.id)
    document.getElementById(`tab-${next.id}`)?.focus()
  }
  return (
    <div className='tabs' role='tablist' aria-label='Board columns'>
      {COLUMNS.map((column, index) => {
        const count = columnCount(column.id, built, closed)
        return (
          <button
            key={column.id}
            id={`tab-${column.id}`}
            type='button'
            role='tab'
            className='tab'
            aria-selected={active === column.id}
            aria-controls={`column-${column.id}`}
            tabIndex={active === column.id ? 0 : -1}
            data-attention={column.id === 'needs' && count.value > 0}
            {...dropAttrs(drag, column.id).props}
            onClick={() => onSelect(column.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <span>{column.title}</span>
            <span className='tab-count'>{countLabel(count)}</span>
          </button>
        )
      })}
    </div>
  )
}

function Message({ children }: { children: string }) {
  return (
    <p className='empty' role='status'>
      {children}
    </p>
  )
}

type ReadySnapshot = Extract<BoardState['snapshot'], { kind: 'ready' }>

type BoardViewProps = {
  ready: ReadySnapshot
  older: BoardState['older']
  changed: ReadonlySet<number>
  closedHasMore: boolean
  filters: Filters
  nowMs: number
  olderStatus: OlderStatus
  onLoadOlder: () => void
  onRetry: () => void
}

function BoardView({
  ready,
  older,
  changed,
  closedHasMore,
  filters,
  nowMs,
  olderStatus,
  onLoadOlder,
  onRetry,
}: BoardViewProps) {
  const [active, setActive] = useState<ColumnId>(FIRST_COLUMN)
  const { fetchedAt, readError } = ready
  const { drag } = useMovesState()
  const moves = useMoves()
  const moved = useMovedBoard(ready.view, older)
  // A drag onto a tab or the screen edge changes the column through the same state the tabs use.
  const registerColumns = moves?.registerColumns
  useEffect(() => {
    registerColumns?.({ active: () => active, select: setActive })
    return () => registerColumns?.(null)
  }, [registerColumns, active])
  const built = buildColumns(moved.view, moved.older?.tasks ?? [], filters.text)
  const closed = closedInfoWithoutCleared(
    closedInfo(moved.full.view, filters, closedHasMore),
    moved.full.view,
    moved.full.older,
    moved.showCleared,
  )
  return (
    <>
      {readError && <ReadBanner failure={readError} lastReadAt={fetchedAt} onRetry={onRetry} />}
      <Tabs built={built} closed={closed} active={active} onSelect={setActive} />
      <main className='board'>
        {COLUMNS.map((column) => {
          const count = columnCount(column.id, built, closed)
          const { drop, props } = dropAttrs(drag, column.id)
          return (
            <section
              key={column.id}
              id={`column-${column.id}`}
              className='column'
              aria-labelledby={`heading-${column.id}`}
              data-active={active === column.id}
              data-column={column.id}
              {...props}
            >
              <h2 id={`heading-${column.id}`} className='column-head'>
                {column.title} <span className='num'>{countLabel(count)}</span>
              </h2>
              {drop.mark === 'refused' && drop.note && <p className='drop-reason'>{drop.note}</p>}
              {(column.id === 'done' || column.id === 'cancelled') && (
                <ColumnTools
                  column={column.id}
                  cards={built[column.id]}
                  showCleared={moved.showCleared}
                  hasCleared={moved.hasCleared}
                />
              )}
              <ColumnBody
                id={column.id}
                built={built}
                nowMs={nowMs}
                changed={changed}
                closedHasMore={closedHasMore}
                olderStatus={olderStatus}
                onLoadOlder={onLoadOlder}
                empty={column.empty}
              />
            </section>
          )
        })}
      </main>
    </>
  )
}

export function BoardPage() {
  const { state, filters, setFilters, olderStatus, loadOlder, retry } = useBoard()
  const session = useSession()
  const nowMs = useNow()
  const deferredText = useDeferredValue(filters.text)
  const shown: Filters = { ...filters, text: deferredText }
  return (
    <MovesProvider token={session?.token ?? null} reload={retry}>
      <BoardShell
        state={state}
        filters={filters}
        setFilters={setFilters}
        shown={shown}
        nowMs={nowMs}
        session={session}
        olderStatus={olderStatus}
        loadOlder={loadOlder}
        retry={retry}
      />
    </MovesProvider>
  )
}

type ShellProps = {
  state: BoardState
  filters: Filters
  setFilters: (next: Filters) => void
  shown: Filters
  nowMs: number
  session: ReturnType<typeof useSession>
  olderStatus: OlderStatus
  loadOlder: () => void
  retry: () => void
}

function BoardShell({ state, filters, setFilters, shown, nowMs, session, olderStatus, loadOlder, retry }: ShellProps) {
  const { snapshot } = state
  return (
    <div className='app'>
      <Header
        connection={connectionOf(state, nowMs)}
        lastReadAt={snapshot.kind === 'ready' ? snapshot.fetchedAt : null}
        build={session?.build ?? null}
      />
      <FilterBar filters={filters} options={state.options} onChange={setFilters} />
      {snapshot.kind === 'loading' && (
        <main className='board' aria-busy='true'>
          <Message>Reading the board</Message>
        </main>
      )}
      {snapshot.kind === 'failed' && (
        <main className='board'>
          <ReadBanner failure={snapshot.failure} lastReadAt={null} onRetry={retry} />
        </main>
      )}
      {snapshot.kind === 'ready' && (
        <BoardView
          ready={snapshot}
          older={state.older}
          changed={state.changed}
          closedHasMore={closedCursor(state) !== null}
          filters={shown}
          nowMs={nowMs}
          olderStatus={olderStatus}
          onLoadOlder={loadOlder}
          onRetry={retry}
        />
      )}
      <MoveSheet />
      <DragLayer />
    </div>
  )
}
