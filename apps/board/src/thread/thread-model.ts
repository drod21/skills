// The journal as a thread, and what the composer and each delivery say. Pure: the page gives it the payload and the
// clock, and it gives back what to draw. Every string that came from the board is passed through untouched; no
// markup is ever built from it.
import { ownerLabel } from '../board/format'
import { threadMarks, type Mark } from '../board/markers'
import type { Thread, ThreadDelivery, ThreadEntry } from './thread-contract'

// ---------------------------------------------------------------- time

/** "14:02" for today, "Nov 9 14:02" for another day. The zone and locale are for tests; the page uses the device's. */
export function timeLabel(
  iso: string | null,
  nowMs: number,
  { timeZone, locale }: { timeZone?: string | undefined; locale?: string | undefined } = {},
) {
  if (iso === null) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const time = new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone })
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone })
  if (day(at) === day(nowMs)) return time
  const date = new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone })
  return `${date} ${time}`
}

export type Clock = { nowMs: number; timeZone?: string | undefined; locale?: string | undefined }
const stamp = (iso: string | null, clock: Clock) =>
  timeLabel(iso, clock.nowMs, { timeZone: clock.timeZone, locale: clock.locale })

// ---------------------------------------------------------------- delivery state

export type DeliveryTone = 'quiet' | 'good' | 'attention'
export type DeliveryView = {
  id: string
  tone: DeliveryTone
  text: string
  /** `retry` re-sends a delivery that gave up; `set-lead` goes to where the lead thread is chosen. */
  action: 'retry' | 'set-lead' | null
}

/** Who a delivery went to. An audience the board adds later reads as "the agent". */
const WHO: Record<string, string> = {
  claim: 'the worker',
  lead: 'the lead',
  'ended-claim': 'the worker that stopped',
}
const whoOf = (audience: string | null) => (audience !== null ? (WHO[audience] ?? 'the agent') : 'the agent')

const attemptsLabel = (count: number) => `${count} ${count === 1 ? 'attempt' : 'attempts'}`

/** One line for one outbox record. A state the page does not know is shown as the board wrote it. */
export function deliveryView(delivery: ThreadDelivery, clock: Clock): DeliveryView {
  const to = whoOf(delivery.audience)
  const base = { id: delivery.id, action: null } as const
  switch (delivery.state) {
    case 'delivered':
      return { ...base, tone: 'good', text: `Delivered to ${to} at ${stamp(delivery.deliveredAt, clock)}`.trimEnd() }
    case 'sending':
      return { ...base, tone: 'quiet', text: `Sending to ${to}` }
    case 'pending':
      return delivery.attempts === 0
        ? { ...base, tone: 'quiet', text: `Waiting to send to ${to}` }
        : {
            ...base,
            tone: 'attention',
            text: `Could not reach ${to} (${attemptsLabel(delivery.attempts)} so far), trying again${
              delivery.nextAttemptAt ? ` at ${stamp(delivery.nextAttemptAt, clock)}` : ''
            }`,
          }
    case 'failed':
      return {
        ...base,
        tone: 'attention',
        text: `Not delivered to ${to} after ${attemptsLabel(delivery.attempts)}${delivery.error ? `: ${delivery.error}` : ''}`,
        action: 'retry',
      }
    case 'unaddressed':
      return {
        ...base,
        tone: 'attention',
        text: `No thread to send to ${to}${delivery.reason ? `: ${delivery.reason}` : ''}`,
        action: 'set-lead',
      }
    default:
      return { ...base, tone: 'quiet', text: `${delivery.state} (to ${to})` }
  }
}

// ---------------------------------------------------------------- the thread

export type MessageItem = {
  type: 'message'
  key: string
  /** Which side of the thread the message sits on: the owner's own words, or an agent's. */
  from: 'owner' | 'agent'
  who: string
  at: string
  text: string
  reopened: string | null
  deliveries: DeliveryView[]
}
export type EventItem = { type: 'event'; key: string; at: string; text: string }
export type ThreadItem = MessageItem | EventItem

const person = (by: string | null, fallback: string) => (by === null || by === '' ? fallback : ownerLabel(by))
const withReason = (text: string, reason: string | null) => (reason ? `${text}: ${reason}` : text)

/** Journal kinds that are the board's bookkeeping, not part of a conversation: they get no line. */
const BACKGROUND_KINDS = new Set(['route', 'jev', 'judgment', 'decide', 'choice', 'copy', 'keep', 'oversize'])

function eventText(entry: ThreadEntry): string {
  const by = entry.by
  switch (entry.kind) {
    case 'note-read':
      return `${person(by, 'The lead')} read your note`
    case 'answer-read':
      return `${person(by, 'The worker')} read your answer`
    case 'release':
      return withReason(by ? `${person(by, '')} released the claim` : 'The claim was released', entry.reason)
    case 'cancel':
      return withReason(by ? `Cancelled by ${person(by, '')}` : 'Cancelled', entry.reason)
    case 'done':
      return by ? `Marked done by ${person(by, '')}` : 'Marked done'
    case 'accept':
      return withReason(`${person(by, 'Someone')} accepted the held check`, entry.reason)
    default: {
      // A kind this page does not know: its name, who, and any text, as plain text.
      const who = by ? ` by ${person(by, '')}` : ''
      return `${entry.kind}${who}${entry.text ? `: ${entry.text}` : ''}`
    }
  }
}

function messageOf(entry: ThreadEntry, index: number, thread: Thread, clock: Clock): MessageItem | null {
  const own = (who: string): Pick<MessageItem, 'from' | 'who'> => ({ from: 'owner', who })
  const deliveries = thread.deliveries
    .filter((record) => record.entryKind === entry.kind && record.entryAt === entry.at)
    .map((record) => deliveryView(record, clock))
  // An accept is an event line until it queues a delivery: then it is a message too, so a delivery that failed has a
  // row to retry from.
  const side: Pick<MessageItem, 'from' | 'who'> | null =
    entry.kind === 'owner-answer' || entry.kind === 'note'
      ? own('You')
      : entry.kind === 'owner-ask'
        ? { from: 'agent', who: person(entry.by, 'A worker') }
        : entry.kind === 'lead-reply'
          ? { from: 'agent', who: person(entry.by, 'The lead') }
          : entry.kind === 'accept' && deliveries.length > 0
            ? own(person(entry.by, 'Someone'))
            : null
  if (side === null) return null
  return {
    type: 'message',
    key: `${entry.kind}-${entry.at}-${index}`,
    ...side,
    at: entry.at,
    text: entry.kind === 'accept' ? withReason('Accepted the held check', entry.reason) : (entry.text ?? ''),
    reopened: entry.reopened,
    deliveries,
  }
}

/** The journal's conversation in the board's order: messages with their deliveries, and one line per event. */
export function buildItems(thread: Thread, clock: Clock): ThreadItem[] {
  const items: ThreadItem[] = []
  thread.entries.forEach((entry, index) => {
    const message = messageOf(entry, index, thread, clock)
    if (message) return void items.push(message)
    if (BACKGROUND_KINDS.has(entry.kind)) return
    items.push({ type: 'event', key: `${entry.kind}-${entry.at}-${index}`, at: entry.at, text: eventText(entry) })
  })
  return items
}

/** Where the conversation stands, from the owner-thread fold the board computes: who owes the next move. */
export function standing(thread: Thread): Mark[] {
  return thread.thread ? threadMarks(thread.thread) : []
}

// ---------------------------------------------------------------- the composer

export type ComposerMode =
  | { kind: 'disabled'; reason: string }
  | {
      kind: 'answer' | 'note'
      label: string
      submit: string
      /** What happens to the message, in one line. */
      hint: string
      /** No thread to wake: the message will be saved and wait. */
      noAddress: boolean
    }

const FINISHED = new Set(['done', 'cancelled'])

/** Answer the open question when there is one; otherwise a note to the lead. */
export function composerMode(thread: Thread): ComposerMode {
  if (thread.task.archived) return { kind: 'disabled', reason: 'This task is archived. It takes no more messages.' }
  const lead = thread.leadAddress
  if (thread.thread?.question === 'Asked') {
    const noAddress = thread.worker === null && lead === null
    return {
      kind: 'answer',
      label: 'Answer the question',
      submit: 'Send answer',
      hint: thread.worker
        ? 'Goes to the worker on the claim.'
        : lead
          ? 'The claim has no worker thread, so it goes to the lead.'
          : 'Nothing has a thread to wake, so the answer will wait.',
      noAddress,
    }
  }
  const reopens = FINISHED.has(thread.task.status) ? 'Sending reopens this task. ' : ''
  const to = lead
    ? thread.worker
      ? 'Goes to the lead and to the worker on the claim.'
      : 'Goes to the lead.'
    : thread.worker
      ? 'No lead thread is set. Goes to the worker on the claim.'
      : 'No lead thread is set, so the note will wait.'
  return {
    kind: 'note',
    label: 'Note to the lead',
    submit: 'Send note',
    hint: `${reopens}${to}`,
    noAddress: lead === null,
  }
}
