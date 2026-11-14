import { describe, expect, it } from 'vitest'
import type { Thread, ThreadDelivery, ThreadEntry } from './thread-contract'
import { buildItems, composerMode, deliveryView, timeLabel, type Clock } from './thread-model'

const clock: Clock = { nowMs: Date.parse('2026-11-10T15:00:00Z'), timeZone: 'UTC', locale: 'en-US' }

const entry = (over: Partial<ThreadEntry> & Pick<ThreadEntry, 'kind' | 'at'>): ThreadEntry => ({
  by: null,
  text: null,
  reason: null,
  reopened: null,
  ...over,
})

const delivery = (over: Partial<ThreadDelivery>): ThreadDelivery => ({
  id: '1-d1',
  entryKind: 'note',
  entryAt: '2026-11-10T14:00:00Z',
  state: 'pending',
  attempts: 0,
  audience: 'lead',
  threadId: 'thread-a',
  nextAttemptAt: null,
  deliveredAt: null,
  failedAt: null,
  error: null,
  since: null,
  reason: null,
  ...over,
})

const thread = (over: Partial<Thread> = {}): Thread => ({
  revision: 'r',
  task: { id: 7, title: 'Add the thread', status: 'claimed', role: 'ux', tag: null, owner: 'ux-1', archived: false },
  thread: { question: 'NoAsk', note: 'NoNote' },
  reviewRevision: 'a'.repeat(64),
  worker: { threadId: 'worker-thread' },
  leadAddress: { source: 'board', threadId: 'lead-thread' },
  canAccept: false,
  entries: [],
  deliveries: [],
  ...over,
})

describe('timeLabel', () => {
  it('shows only the time for today and the date for another day', () => {
    expect(timeLabel('2026-11-10T14:02:00Z', clock.nowMs, clock)).toBe('2:02 PM')
    expect(timeLabel('2026-11-09T14:02:00Z', clock.nowMs, clock)).toBe('Nov 9 2:02 PM')
  })
  it('is empty for a missing or unreadable time', () => {
    expect(timeLabel(null, clock.nowMs, clock)).toBe('')
    expect(timeLabel('not a time', clock.nowMs, clock)).toBe('')
  })
})

describe('deliveryView', () => {
  it('says when a message was delivered and to whom', () => {
    const view = deliveryView(delivery({ state: 'delivered', deliveredAt: '2026-11-10T14:05:00Z' }), clock)
    expect(view).toMatchObject({ tone: 'good', text: 'Delivered to the lead at 2:05 PM', action: null })
  })
  it('says a message is waiting, then that it is retrying with the next time', () => {
    expect(deliveryView(delivery({}), clock).text).toBe('Waiting to send to the lead')
    const retrying = deliveryView(
      delivery({ attempts: 2, nextAttemptAt: '2026-11-10T15:10:00Z', audience: 'claim' }),
      clock,
    )
    expect(retrying.tone).toBe('attention')
    expect(retrying.text).toBe('Could not reach the worker (2 attempts so far), trying again at 3:10 PM')
  })
  it('offers Retry once a delivery gave up, with the reason and the attempt count', () => {
    const view = deliveryView(delivery({ state: 'failed', attempts: 6, error: 'thread not found' }), clock)
    expect(view.text).toBe('Not delivered to the lead after 6 attempts: thread not found')
    expect(view.action).toBe('retry')
  })
  it('sends the owner to the lead thread setting when there is no address', () => {
    const view = deliveryView(delivery({ state: 'unaddressed', reason: 'no lead thread set' }), clock)
    expect(view).toMatchObject({ tone: 'attention', action: 'set-lead' })
    expect(view.text).toBe('No thread to send to the lead: no lead thread set')
  })
  it('shows a state it does not know as plain text instead of failing', () => {
    expect(deliveryView(delivery({ state: 'parked', audience: 'someone-new' }), clock)).toMatchObject({
      tone: 'quiet',
      text: 'parked (to the agent)',
      action: null,
    })
  })
})

describe('buildItems', () => {
  it('lays messages and events out in journal order with their deliveries', () => {
    const items = buildItems(
      thread({
        entries: [
          entry({ kind: 'owner-ask', at: '2026-11-10T13:00:00Z', by: 'ux-1', text: 'Which tab first?' }),
          entry({ kind: 'owner-answer', at: '2026-11-10T14:00:00Z', text: 'Needs me.' }),
          entry({ kind: 'answer-read', at: '2026-11-10T14:03:00Z', by: 'ux-1' }),
        ],
        deliveries: [delivery({ entryKind: 'owner-answer', state: 'delivered', deliveredAt: '2026-11-10T14:01:00Z' })],
      }),
      clock,
    )
    expect(items.map((item) => item.type)).toEqual(['message', 'message', 'event'])
    expect(items[0]).toMatchObject({ from: 'agent', text: 'Which tab first?' })
    expect(items[1]).toMatchObject({ from: 'owner', who: 'You' })
    expect(items[1]?.type === 'message' && items[1].deliveries).toHaveLength(1)
    expect(items[2]).toMatchObject({ type: 'event', text: expect.stringContaining('read your answer') })
  })
  it('keeps bookkeeping kinds out of the thread and shows an unknown kind as plain text', () => {
    const items = buildItems(
      thread({
        entries: [
          entry({ kind: 'route', at: '2026-11-10T10:00:00Z' }),
          entry({ kind: 'brand-new-kind', at: '2026-11-10T11:00:00Z', by: 'qa-1', text: '<b>hi</b>' }),
        ],
      }),
      clock,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'event' })
    expect(items[0]?.type === 'event' && items[0].text).toContain('<b>hi</b>')
  })
  it('is empty for a thread with no entries', () => {
    expect(buildItems(thread(), clock)).toEqual([])
  })
})

describe('composerMode', () => {
  it('answers when a question is open and says where it goes', () => {
    const mode = composerMode(thread({ thread: { question: 'Asked', note: 'NoNote' } }))
    expect(mode).toMatchObject({ kind: 'answer', submit: 'Send answer', noAddress: false })
  })
  it('writes a note to the lead otherwise', () => {
    expect(composerMode(thread())).toMatchObject({ kind: 'note', submit: 'Send note', noAddress: false })
  })
  it('warns when nothing has a thread to wake', () => {
    const mode = composerMode(thread({ worker: null, leadAddress: null }))
    expect(mode).toMatchObject({ kind: 'note', noAddress: true })
    expect(
      composerMode(thread({ worker: null, leadAddress: null, thread: { question: 'Asked', note: 'NoNote' } })),
    ).toMatchObject({
      kind: 'answer',
      noAddress: true,
    })
  })
  it('says a note reopens a finished task', () => {
    const done = thread()
    const mode = composerMode({ ...done, task: { ...done.task, status: 'done' } })
    expect(mode.kind === 'note' && mode.hint).toContain('reopens')
  })
  it('takes no message for an archived task', () => {
    const open = thread()
    expect(composerMode({ ...open, task: { ...open.task, archived: true } }).kind).toBe('disabled')
  })
})
