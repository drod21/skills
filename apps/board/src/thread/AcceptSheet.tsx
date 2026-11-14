// The sheet that accepts a held evidence check. It asks for a reason, because the board records who accepted what and
// why; nothing is sent until the owner types one and confirms.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { acceptCheck } from './thread-client'

const MAX_REASON = 1000

export function AcceptSheet({
  taskId,
  title,
  onClose,
  onAccepted,
}: {
  taskId: number
  title: string | null
  onClose: () => void
  onAccepted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const trimmed = reason.trim()
  const canSend = trimmed !== '' && trimmed.length <= MAX_REASON && !sending

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSend) return
    setSending(true)
    setError(null)
    const result = await acceptCheck(taskId, trimmed)
    setSending(false)
    if (result.ok) {
      onAccepted()
      onClose()
    } else {
      setError(result.failure.message)
    }
  }

  return (
    <dialog ref={dialog} className='sheet' aria-labelledby={`accept-${taskId}-title`} onClose={onClose}>
      <form onSubmit={submit} className='sheet-body'>
        <h2 id={`accept-${taskId}-title`} className='sheet-title'>
          Accept the held check on #{taskId}
        </h2>
        {title && <p className='sheet-sub'>{title}</p>}
        <p className='sheet-note'>
          The check stays held until you accept it. Your reason goes on the record for this task.
        </p>
        <label className='field'>
          <span>Why is it fine to accept?</span>
          <textarea
            className='input textarea'
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={MAX_REASON}
            autoFocus
          />
        </label>
        {error && (
          <p className='sheet-error' role='alert'>
            Not accepted: {error}
          </p>
        )}
        <div className='sheet-actions'>
          <button type='button' className='button' onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type='submit' className='button' data-primary='true' disabled={!canSend}>
            {sending ? 'Accepting' : 'Accept check'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
