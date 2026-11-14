// One task on the board. The whole card is the link to `/tasks/$id`; the marks say what needs a look.
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  BellOff,
  CircleHelp,
  Hourglass,
  MessageSquare,
  Send,
  StickyNote,
  User,
  type LucideIcon,
} from 'lucide-react'
import { CardMoveControls } from '../moves/CardMoveControls'
import { useMoves } from '../moves/MovesProvider'
import type { BoardCard } from './board-contract'
import { isKnownStatus } from './columns'
import { ageLabel, ownerLabel } from './format'
import { marksOf, type Mark, type MarkKind } from './markers'

const MARK_ICONS: Record<MarkKind, LucideIcon> = {
  question: CircleHelp,
  answer: MessageSquare,
  note: StickyNote,
  lead: ArrowUpRight,
  undelivered: Send,
  waits: Hourglass,
  silent: BellOff,
}

export function MarkLines({ marks }: { marks: readonly Mark[] }) {
  if (marks.length === 0) return null
  return (
    <ul className='marks'>
      {marks.map((mark) => {
        const Icon = MARK_ICONS[mark.kind]
        return (
          <li key={`${mark.kind}-${mark.text}`} className='mark' data-tone={mark.tone} data-mark={mark.kind}>
            <Icon aria-hidden='true' />
            <span>{mark.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** The time a card's age counts from: the last sign of life for a claim, the close for a finished task. */
function ageOf(card: BoardCard, nowMs: number): string | null {
  const from = card.status === 'claimed' ? (card.lastSignalAt ?? card.claimedAt) : card.closedAt
  const age = ageLabel(from, nowMs)
  return age === null ? null : age === 'now' ? 'now' : `${age} ago`
}

export function TaskCard({ card, nowMs, changed }: { card: BoardCard; nowMs: number; changed: boolean }) {
  const marks = marksOf(card, nowMs)
  const age = ageOf(card, nowMs)
  const dragProps = useMoves()?.cardProps(card)
  return (
    <li
      className='card'
      data-task-id={card.id}
      data-status={card.status}
      data-changed={changed}
      data-attention={marks.some((mark) => mark.tone === 'attention')}
      {...dragProps}
    >
      <div className='card-top'>
        <span className='card-id'>#{card.id}</span>
        {!isKnownStatus(card.status) && <span>{card.status}</span>}
        {card.role && <span>{card.role}</span>}
        {card.tag && <span>{card.tag}</span>}
        {age && <span className='card-age'>{age}</span>}
      </div>
      <p className='card-title'>
        <Link to='/tasks/$id' params={{ id: card.id }} className='card-link' draggable={false}>
          {card.title ?? 'Untitled task'}
        </Link>
      </p>
      {card.owner && (
        <div className='owner' title={card.owner}>
          <User aria-hidden='true' />
          <span>{ownerLabel(card.owner)}</span>
        </div>
      )}
      <MarkLines marks={marks} />
      <CardMoveControls card={card} />
    </li>
  )
}
