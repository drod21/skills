// Where the owner's notes go: the lead's T3 thread for the whole board, and optionally a different one per tag. A
// task's notes use its tag's thread when there is one, and the board's otherwise.
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { fetchBoard } from '../board/board-client'
import type { BoardFailure, BoardView } from '../board/board-contract'
import { fetchThreadList, setLeadThread } from './thread-client'
import type { ThreadListItem } from './thread-contract'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: BoardFailure }
  | { kind: 'ready'; view: BoardView; threads: ThreadListItem[]; threadsError: BoardFailure | null }

const NONE = ''
const NO_FILTERS = { role: '', tag: '', owner: '' }

async function readSettings(signal: AbortSignal): Promise<Loaded> {
  const [board, list] = await Promise.all([fetchBoard(NO_FILTERS, null, signal), fetchThreadList(signal)])
  if (!board.ok) return { kind: 'failed', failure: board.failure }
  return {
    kind: 'ready',
    view: board.view,
    threads: list.ok ? list.threads : [],
    threadsError: list.ok ? null : list.failure,
  }
}

/** Reads the board and the T3 thread list on mount, and again on `reload`. The last good read stays up meanwhile. */
function useLeadSettings() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    readSettings(controller.signal).then(setLoaded, () => undefined)
    return () => controller.abort()
  }, [])

  const reload = useCallback(() => {
    readSettings(new AbortController().signal).then(setLoaded, () => undefined)
  }, [])
  return { loaded, reload }
}

const label = (thread: ThreadListItem) => thread.title ?? thread.threadId

function LeadPicker({
  heading,
  scope,
  current,
  threads,
  onSaved,
}: {
  heading: string
  scope: string | null
  current: string | null
  threads: ThreadListItem[]
  onSaved: () => void
}) {
  const [choice, setChoice] = useState(current ?? NONE)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const known = threads.some((thread) => thread.threadId === current)
  const changed = choice !== (current ?? NONE)

  async function save() {
    setSaving(true)
    setMessage(null)
    const result = await setLeadThread({
      ...(choice === NONE ? {} : { threadId: choice }),
      ...(scope === null ? {} : { tag: scope }),
    })
    setSaving(false)
    if (result.ok) {
      setMessage({ ok: true, text: choice === NONE ? 'Cleared.' : 'Saved.' })
      onSaved()
    } else {
      setMessage({ ok: false, text: `Not saved: ${result.failure.message}` })
    }
  }

  return (
    <section className='lead-picker' data-scope={scope === null ? 'board' : 'tag'} data-tag={scope ?? undefined}>
      <h2 className='section-title'>{heading}</h2>
      <label className='field'>
        <span>Thread</span>
        <select className='select' value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value={NONE}>{scope === null ? 'No lead thread' : 'Use the board lead'}</option>
          {current !== null && !known && <option value={current}>{current} (not in the project list)</option>}
          {threads.map((thread) => (
            <option key={thread.threadId} value={thread.threadId}>
              {label(thread)}
            </option>
          ))}
        </select>
      </label>
      <div className='lead-actions'>
        <button type='button' className='button' data-primary='true' disabled={!changed || saving} onClick={save}>
          {saving ? 'Saving' : 'Save'}
        </button>
        {message && (
          <p className='lead-message' role={message.ok ? 'status' : 'alert'} data-ok={message.ok}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  )
}

export function LeadSettings() {
  const { loaded, reload } = useLeadSettings()
  return (
    <main className='page settings-page'>
      <Link to='/' className='back'>
        <ArrowLeft aria-hidden='true' />
        <span>Board</span>
      </Link>
      <h1 className='title'>Lead thread</h1>
      <p className='lede'>
        Your notes wake the lead in this T3 thread. A tag can have its own; a task with that tag uses it first.
      </p>
      {loaded.kind === 'loading' && (
        <p className='empty' role='status'>
          Reading the board
        </p>
      )}
      {loaded.kind === 'failed' && (
        <div className='banner' role='alert' data-state='unreadable'>
          <p>Cannot read the board: {loaded.failure.message}.</p>
          <button type='button' className='button' onClick={reload}>
            <RefreshCw aria-hidden='true' />
            <span>Retry</span>
          </button>
        </div>
      )}
      {loaded.kind === 'ready' && (
        <>
          {loaded.threadsError && (
            <div className='banner' role='alert' data-state='threads-unreadable'>
              <p>Cannot list T3 threads: {loaded.threadsError.message}. You can still clear a thread.</p>
              <button type='button' className='button' onClick={reload}>
                <RefreshCw aria-hidden='true' />
                <span>Retry</span>
              </button>
            </div>
          )}
          <Pickers view={loaded.view} threads={loaded.threads} onSaved={reload} />
        </>
      )}
    </main>
  )
}

function Pickers({ view, threads, onSaved }: { view: BoardView; threads: ThreadListItem[]; onSaved: () => void }) {
  const tagLeads = view.leadTags ?? {}
  const tags = [
    ...new Set([
      ...Object.keys(tagLeads),
      ...[...view.tasks, ...view.closed.tasks].flatMap((card) => (card.tag === null ? [] : [card.tag])),
    ]),
  ].toSorted((a, b) => a.localeCompare(b))
  return (
    <div className='lead-pickers'>
      <LeadPicker
        key='board'
        heading='Whole board'
        scope={null}
        current={view.lead?.threadId ?? null}
        threads={threads}
        onSaved={onSaved}
      />
      {tags.map((tag) => (
        <LeadPicker
          key={`tag-${tag}`}
          heading={`Tag: ${tag}`}
          scope={tag}
          current={tagLeads[tag]?.threadId ?? null}
          threads={threads}
          onSaved={onSaved}
        />
      ))}
    </div>
  )
}
