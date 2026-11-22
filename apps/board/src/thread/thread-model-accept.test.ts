// Board task 1644, F5: an accept in the thread carries its deliveries, so a failed one gets a retry row.
import { describe, expect, it } from 'vitest'
import type { Thread, ThreadDelivery, ThreadEntry } from './thread-contract'
import { buildItems, type Clock } from './thread-model'

const clock: Clock = { nowMs: Date.parse('2026-11-10T15:00:00Z'), timeZone: 'UTC', locale: 'en-US' }
const AT = '2026-11-10T14:00:00Z'

const accept = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  kind: 'accept',
  at: AT,
  by: 'lead-l',
  text: null,
  reason: 'Looks right.',
  reopened: null,
  ...over,
})

const delivery = (over: Partial<ThreadDelivery>): ThreadDelivery => ({
  id: '7-d1',
  entryKind: 'accept',
  entryAt: AT,
  state: 'failed',
  attempts: 6,
  audience: 'claim',
  threadId: 'thread-a',
  nextAttemptAt: null,
  deliveredAt: null,
  failedAt: '2026-11-10T14:30:00Z',
  error: 'no such thread',
  since: null,
  reason: null,
  ...over,
})

const thread = (entries: ThreadEntry[], deliveries: ThreadDelivery[]): Thread => ({
  revision: 'r',
  task: { id: 7, title: 'Add the thread', status: 'claimed', role: 'ux', tag: null, owner: 'ux-1', archived: false },
  thread: { question: 'NoAsk', note: 'NoNote' },
  reviewRevision: 'a'.repeat(64),
  worker: { threadId: 'worker-thread' },
  leadAddress: { source: 'board', threadId: 'lead-thread' },
  canAccept: false,
  entries,
  deliveries,
})

describe('an accept in the thread', () => {
  it('shows a failed accept delivery with a Retry action', () => {
    const [item] = buildItems(thread([accept()], [delivery({})]), clock)
    expect(item).toMatchObject({ type: 'message', at: AT })
    if (item?.type !== 'message') throw new Error('expected a message item')
    expect(item.text).toContain('Looks right.')
    expect(item.deliveries).toHaveLength(1)
    expect(item.deliveries[0]).toMatchObject({ id: '7-d1', tone: 'attention', action: 'retry' })
  })

  it('shows an unaddressed accept delivery with the set-lead action', () => {
    const unaddressed = delivery({ state: 'unaddressed', since: AT, reason: 'the board has no lead address' })
    const [item] = buildItems(thread([accept()], [unaddressed]), clock)
    if (item?.type !== 'message') throw new Error('expected a message item')
    expect(item.deliveries[0]?.action).toBe('set-lead')
  })

  it('does not attach another entry kind delivery from the same moment', () => {
    const items = buildItems(thread([accept()], [delivery({ entryKind: 'note', id: '7-d2' })]), clock)
    expect(items.flatMap((item) => (item.type === 'message' ? item.deliveries : []))).toEqual([])
  })

  it('stays a one-line event when the accept queued no delivery', () => {
    const [item] = buildItems(thread([accept()], []), clock)
    expect(item).toMatchObject({ type: 'event', text: 'lead-l accepted the held check: Looks right.' })
  })
})
