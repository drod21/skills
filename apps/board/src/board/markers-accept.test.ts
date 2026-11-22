// Board task 1644, F5: an accept record counts for the card marker the way a message record does.
import { describe, expect, it } from 'vitest'
import { cardOf, fixtureView } from '../../tests/fixtures/view'
import { marksOf } from './markers'

const nowMs = Date.parse(fixtureView.now)

const accept = (state: string, over: Record<string, unknown> = {}) => ({
  id: '9-d1',
  entryKind: 'accept',
  entryAt: '2026-11-10T14:00:00Z',
  audience: { kind: 'claim' },
  attempts: 0,
  state,
  ...over,
})

/** A card whose only outbox record is an accept: an accept is not one of the card's `messages`. */
function withAccept(state: string) {
  const record = accept(state)
  return { ...cardOf(9), messages: [], deliveries: [record], undelivered: state === 'delivered' ? 0 : 1 }
}

const undelivered = (card: ReturnType<typeof withAccept>) =>
  marksOf(card as never, nowMs).find((mark) => mark.kind === 'undelivered')

describe('the undelivered mark counts an accept record', () => {
  it('calls a failed accept not delivered, as an attention mark', () => {
    expect(undelivered(withAccept('failed'))).toEqual({
      kind: 'undelivered',
      tone: 'attention',
      text: '1 not delivered',
    })
  })

  it('calls an unaddressed accept not delivered, as an attention mark', () => {
    expect(undelivered(withAccept('unaddressed'))?.tone).toBe('attention')
  })

  it('still calls a pending accept on its way', () => {
    expect(undelivered(withAccept('pending'))).toEqual({ kind: 'undelivered', tone: 'quiet', text: '1 on the way' })
  })

  it('marks nothing for a delivered accept', () => {
    expect(undelivered(withAccept('delivered'))).toBeUndefined()
  })

  it('reads a failed message and a pending accept together as stuck', () => {
    const card = cardOf(8)
    const mixed = { ...card, deliveries: [accept('pending'), ...card.messages.flatMap((m) => m.deliveries)] }
    expect(undelivered(mixed as never)?.tone).toBe('attention')
  })

  it('falls back to the messages when a card carries no top-level deliveries (an older CLI)', () => {
    expect(marksOf(cardOf(8), nowMs).find((mark) => mark.kind === 'undelivered')?.tone).toBe('attention')
  })
})
