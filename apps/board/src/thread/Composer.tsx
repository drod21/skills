// Where the owner types. It is an answer when a question is open and a note to the lead otherwise; the text stays in
// the box until the board has taken it, so a failed send loses nothing.
import { Link } from '@tanstack/react-router'
import { Send, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { sendMessage } from './thread-client'
import { MAX_TEXT_CHARS, type Thread } from './thread-contract'
import { composerMode } from './thread-model'

const COUNTER_FROM = MAX_TEXT_CHARS - 500

export function Composer({ thread, onSent }: { thread: Thread; onSent: () => void }) {
  const mode = composerMode(thread)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (mode.kind === 'disabled') {
    return (
      <p className='composer-off' data-state='disabled'>
        {mode.reason}
      </p>
    )
  }

  const trimmed = text.trim()
  const tooLong = trimmed.length > MAX_TEXT_CHARS
  const canSend = trimmed !== '' && !tooLong && !sending

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!canSend || mode.kind === 'disabled') return
    setSending(true)
    setError(null)
    const result = await sendMessage(thread.task.id, {
      kind: mode.kind,
      text: trimmed,
      ...(thread.reviewRevision === null ? {} : { expected: thread.reviewRevision }),
    })
    setSending(false)
    if (result.ok) {
      setText('')
      onSent()
    } else {
      // The text stays where it is. The board's own words say why.
      setError(result.failure.message)
      onSent()
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
  }

  return (
    <form className='composer' onSubmit={submit} data-mode={mode.kind} data-state={sending ? 'sending' : 'idle'}>
      {mode.noAddress && (
        <p className='composer-warn' data-state='no-address'>
          <TriangleAlert aria-hidden='true' />
          <span>
            No thread to wake for this task. The message is saved and waits.{' '}
            <Link to='/settings'>Set the lead thread</Link>
          </span>
        </p>
      )}
      <label className='field'>
        <span className='composer-label'>{mode.label}</span>
        <textarea
          className='input textarea'
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby='composer-hint'
          aria-invalid={tooLong || error !== null}
          readOnly={sending}
        />
      </label>
      <p id='composer-hint' className='composer-hint'>
        {mode.hint}
        {(tooLong || trimmed.length >= COUNTER_FROM) && (
          <span className='num' data-over={tooLong}>
            {' '}
            {trimmed.length}/{MAX_TEXT_CHARS}
          </span>
        )}
      </p>
      {error && (
        <p className='composer-error' role='alert'>
          <TriangleAlert aria-hidden='true' />
          <span>Not sent: {error}. Your text is still here.</span>
        </p>
      )}
      <button type='submit' className='button' data-primary='true' disabled={!canSend}>
        <Send aria-hidden='true' />
        <span>{sending ? 'Sending' : mode.submit}</span>
      </button>
    </form>
  )
}
