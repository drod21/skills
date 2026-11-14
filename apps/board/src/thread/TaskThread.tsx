// One task's journal as a thread: who said what, whether each message arrived, and the box to say more. All text from
// the board is React text; none of it is ever markup or a link.
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Check, Clock, RefreshCw, ShieldCheck, TriangleAlert, User, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { ownerLabel } from '../board/format'
import { TaskStatusLine } from './TaskStatusLine'
import { MarkLines } from '../board/TaskCard'
import { useNow } from '../board/use-board'
import { AcceptSheet } from './AcceptSheet'
import { Composer } from './Composer'
import { retryDelivery } from './thread-client'
import type { Thread } from './thread-contract'
import {
  buildItems,
  standing,
  timeLabel,
  type DeliveryTone,
  type DeliveryView,
  type MessageItem,
  type ThreadItem,
} from './thread-model'
import { useThread } from './use-thread'

const TONE_ICON: Record<DeliveryTone, LucideIcon> = { good: Check, quiet: Clock, attention: TriangleAlert }

function DeliveryLine({ taskId, view, onChanged }: { taskId: number; view: DeliveryView; onChanged: () => void }) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const Icon = TONE_ICON[view.tone]

  async function retry() {
    setRetrying(true)
    setError(null)
    const result = await retryDelivery(taskId, view.id)
    setRetrying(false)
    if (!result.ok) setError(result.failure.message)
    onChanged()
  }

  return (
    <li className='delivery' data-tone={view.tone} data-delivery={view.id}>
      <Icon aria-hidden='true' />
      <span className='delivery-text'>{view.text}</span>
      {view.action === 'retry' && (
        <button type='button' className='button' data-small='true' onClick={retry} disabled={retrying}>
          <RefreshCw aria-hidden='true' />
          <span>{retrying ? 'Retrying' : 'Retry'}</span>
        </button>
      )}
      {view.action === 'set-lead' && (
        <Link to='/settings' className='button' data-small='true'>
          Set the lead thread
        </Link>
      )}
      {error && (
        <span className='delivery-error' role='alert'>
          Retry failed: {error}
        </span>
      )}
    </li>
  )
}

function Message({
  item,
  taskId,
  nowMs,
  onChanged,
}: {
  item: MessageItem
  taskId: number
  nowMs: number
  onChanged: () => void
}) {
  return (
    <li className='message' data-from={item.from} data-reopened={item.reopened !== null}>
      <div className='message-top'>
        <span className='message-who'>{item.who}</span>
        <time dateTime={item.at}>{timeLabel(item.at, nowMs)}</time>
      </div>
      <p className='message-text'>{item.text}</p>
      {item.reopened !== null && <p className='message-note'>This reopened the task.</p>}
      {item.deliveries.length > 0 && (
        <ul className='deliveries'>
          {item.deliveries.map((view) => (
            <DeliveryLine key={view.id} taskId={taskId} view={view} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </li>
  )
}

function Items({
  items,
  taskId,
  nowMs,
  onChanged,
}: {
  items: ThreadItem[]
  taskId: number
  nowMs: number
  onChanged: () => void
}) {
  return (
    <ol className='thread' aria-label='Thread'>
      {items.map((item) =>
        item.type === 'message' ? (
          <Message key={item.key} item={item} taskId={taskId} nowMs={nowMs} onChanged={onChanged} />
        ) : (
          <li key={item.key} className='event'>
            <span>{item.text}</span>
            <time dateTime={item.at}>{timeLabel(item.at, nowMs)}</time>
          </li>
        ),
      )}
    </ol>
  )
}

function Ready({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const nowMs = useNow()
  const [accepting, setAccepting] = useState(false)
  const items = buildItems(thread, { nowMs })
  const marks = standing(thread)
  const { task } = thread
  return (
    <>
      <header className='task-head'>
        <div className='card-top'>
          <span className='card-id'>#{task.id}</span>
          <TaskStatusLine task={task} />
        </div>
        <h1 className='title'>{task.title ?? 'Untitled task'}</h1>
        {task.owner && (
          <div className='owner' title={task.owner}>
            <User aria-hidden='true' />
            <span>{ownerLabel(task.owner)}</span>
          </div>
        )}
        <MarkLines marks={marks} />
        {thread.canAccept && (
          <div className='hold'>
            <p>
              <ShieldCheck aria-hidden='true' />
              <span>An evidence check is held for you.</span>
            </p>
            <button type='button' className='button' onClick={() => setAccepting(true)}>
              Accept the check
            </button>
          </div>
        )}
      </header>
      {items.length === 0 ? (
        <p className='empty thread-empty' data-state='empty'>
          Nothing has been said on this task yet. Your first note goes to the lead.
        </p>
      ) : (
        <Items items={items} taskId={task.id} nowMs={nowMs} onChanged={onChanged} />
      )}
      <Composer thread={thread} onSent={onChanged} />
      {accepting && (
        <AcceptSheet taskId={task.id} title={task.title} onClose={() => setAccepting(false)} onAccepted={onChanged} />
      )}
    </>
  )
}

export function TaskThread({ id }: { id: number }) {
  const { state, live, refresh } = useThread(id)
  return (
    <main className='page thread-page' data-live={live}>
      <Link to='/' className='back'>
        <ArrowLeft aria-hidden='true' />
        <span>Board</span>
      </Link>
      {state.kind === 'loading' && (
        <p className='empty' role='status'>
          Reading the thread
        </p>
      )}
      {state.kind === 'missing' && (
        <>
          <h1 className='title'>Task #{id}</h1>
          <p className='empty' data-state='missing'>
            This board has no task #{id}.
          </p>
        </>
      )}
      {state.kind === 'failed' && (
        <>
          <h1 className='title'>Task #{id}</h1>
          <div className='banner' role='alert' data-state='unreadable'>
            <p>Cannot read the board: {state.failure.message}.</p>
            <button type='button' className='button' onClick={refresh}>
              <RefreshCw aria-hidden='true' />
              <span>Retry</span>
            </button>
          </div>
        </>
      )}
      {state.kind === 'ready' && (
        <>
          {state.readError && (
            <div className='banner' role='alert' data-state='stale'>
              <p>Cannot refresh: {state.readError.message}. Showing the last thread read.</p>
              <button type='button' className='button' onClick={refresh}>
                <RefreshCw aria-hidden='true' />
                <span>Retry</span>
              </button>
            </div>
          )}
          <Ready thread={state.thread} onChanged={refresh} />
        </>
      )}
    </main>
  )
}
