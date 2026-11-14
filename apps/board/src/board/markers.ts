// The small facts a card carries beyond its title: a message nobody has read or that did not go out, a wait on
// other tasks, a claim that went quiet. One function turns a card into its marks, so the card only draws them.
import type { BoardCard } from './board-contract'
import { hoursSince } from './format'

type Thread = BoardCard['ownerThread']

export type MarkKind = 'question' | 'answer' | 'note' | 'lead' | 'undelivered' | 'waits' | 'silent'
/** `attention` is something the owner can act on or that went wrong; `quiet` is information. */
export type Mark = { kind: MarkKind; tone: 'attention' | 'quiet'; text: string }

const MAX_WAITS_LISTED = 3

/** What the owner thread says about a task, for a card or a row in the lead's list. */
export function threadMarks(thread: Thread): Mark[] {
  const marks: Mark[] = []
  if (thread.question === 'Asked') marks.push({ kind: 'question', tone: 'attention', text: 'Question for you' })
  if (thread.question === 'Answered') marks.push({ kind: 'answer', tone: 'quiet', text: 'Answer unread' })
  if (thread.question === 'HandedToLead') marks.push({ kind: 'lead', tone: 'quiet', text: 'Question with the lead' })
  if (thread.note === 'NoteQueued') marks.push({ kind: 'note', tone: 'quiet', text: 'Note unread' })
  if (thread.note === 'NoteRead') marks.push({ kind: 'note', tone: 'quiet', text: 'Note read, no reply' })
  return marks
}

function deliveryMark(card: BoardCard): Mark[] {
  if (card.undelivered === 0) return []
  const stuck = card.messages.some((message) =>
    message.deliveries.some((delivery) => delivery.state === 'failed' || delivery.state === 'unaddressed'),
  )
  return [
    stuck
      ? { kind: 'undelivered', tone: 'attention', text: `${card.undelivered} not delivered` }
      : { kind: 'undelivered', tone: 'quiet', text: `${card.undelivered} on the way` },
  ]
}

function waitsMark({ waitsOn }: BoardCard): Mark[] {
  if (waitsOn.length === 0) return []
  const listed = waitsOn.slice(0, MAX_WAITS_LISTED).map((wait) => `#${wait.id}`)
  const rest = waitsOn.length - listed.length
  return [{ kind: 'waits', tone: 'quiet', text: `Waits on ${listed.join(', ')}${rest > 0 ? ` +${rest}` : ''}` }]
}

function silentMark(card: BoardCard, nowMs: number): Mark[] {
  if (card.status !== 'claimed' || !card.silent) return []
  const hours = hoursSince(card.lastSignalAt ?? card.claimedAt, nowMs)
  return [{ kind: 'silent', tone: 'quiet', text: hours === null ? 'No sign of life' : `Silent for ${hours} h` }]
}

export function marksOf(card: BoardCard, nowMs: number): Mark[] {
  return [...threadMarks(card.ownerThread), ...deliveryMark(card), ...waitsMark(card), ...silentMark(card, nowMs)]
}
