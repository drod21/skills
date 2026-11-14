// A row in the "Needs me" lane: a task, and the reasons it is waiting on the owner. Also the quieter rows for work
// that sits with the lead.
import { Link } from '@tanstack/react-router'
import { CircleHelp, CircleX, Pause, Send, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { AcceptSheet } from '../thread/AcceptSheet'
import type { LeadRow, NeedsReason, NeedsRow } from './board-contract'
import { asksOwner } from './columns'
import { MarkLines } from './TaskCard'
import { threadMarks } from './markers'

function describe(reason: NeedsReason): { Icon: LucideIcon; text: string } {
  switch (reason.why) {
    case 'question':
      return { Icon: CircleHelp, text: reason.text ?? 'A worker asked you a question' }
    case 'hold':
      return { Icon: Pause, text: reason.tool ? `Held for you: ${reason.tool}` : 'Held for you' }
    case 'rejected':
      return { Icon: CircleX, text: reason.tool ? `Rejected: ${reason.tool}` : 'Rejected' }
    case 'delivery':
      return {
        Icon: Send,
        text: `Message ${reason.state}${reason.detail ? `: ${reason.detail}` : ''}`,
      }
    case 'other':
      return { Icon: CircleHelp, text: reason.text ?? `Waiting on you: ${reason.name}` }
  }
}

function RowTitle({ row }: { row: NeedsRow | LeadRow }) {
  return (
    <>
      <div className='card-top'>
        <span className='card-id'>#{row.id}</span>
        <span>{row.status}</span>
      </div>
      <p className='card-title'>
        <Link to='/tasks/$id' params={{ id: row.id }} className='card-link'>
          {row.title ?? 'Untitled task'}
        </Link>
      </p>
    </>
  )
}

export function NeedsCard({ row }: { row: NeedsRow }) {
  const [accepting, setAccepting] = useState(false)
  const acceptable = row.reasons.some((reason) => reason.why === 'hold' && reason.canAccept)
  return (
    <li className='card' data-task-id={row.id} data-attention={row.reasons.some(asksOwner)} data-lane='needs'>
      <RowTitle row={row} />
      <ul className='reasons'>
        {row.reasons.map((reason, index) => {
          const { Icon, text } = describe(reason)
          return (
            <li
              key={`${reason.why}-${index}`}
              className='reason'
              data-tone={asksOwner(reason) ? 'attention' : 'quiet'}
              data-reason={reason.why}
            >
              <Icon aria-hidden='true' />
              <span className='reason-text'>{text}</span>
            </li>
          )
        })}
      </ul>
      {acceptable && (
        <button type='button' className='button card-action' onClick={() => setAccepting(true)}>
          <ShieldCheck aria-hidden='true' />
          <span>Accept the check</span>
        </button>
      )}
      {accepting && (
        // Accepting changes the board, and the board's own stream brings the row's new state.
        <AcceptSheet taskId={row.id} title={row.title} onClose={() => setAccepting(false)} onAccepted={noop} />
      )}
    </li>
  )
}

const noop = () => undefined

export function LeadCard({ row }: { row: LeadRow }) {
  return (
    <li className='card' data-task-id={row.id} data-lane='lead'>
      <RowTitle row={row} />
      <MarkLines marks={threadMarks({ question: row.question, note: row.note })} />
    </li>
  )
}
