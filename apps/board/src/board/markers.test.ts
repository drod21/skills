import { describe, expect, it } from 'vitest'
import { cardOf, fixtureView } from '../../tests/fixtures/view'
import { marksOf, threadMarks } from './markers'

const nowMs = Date.parse(fixtureView.now)
const texts = (id: number) => marksOf(cardOf(id), nowMs).map((mark) => mark.text)

describe('marksOf', () => {
  it('marks a question the owner has not answered', () => {
    expect(marksOf(cardOf(7), nowMs)).toEqual([{ kind: 'question', tone: 'attention', text: 'Question for you' }])
  })

  it('marks an unread note and the message that was not delivered', () => {
    expect(texts(8)).toEqual(['Note unread', '1 not delivered'])
    expect(marksOf(cardOf(8), nowMs).find((mark) => mark.kind === 'undelivered')?.tone).toBe('attention')
  })

  it('marks a task that waits on another', () => {
    expect(texts(3)).toEqual(['Waits on #1'])
  })

  it('lists at most three waits and counts the rest', () => {
    const waitsOn = [1, 2, 3, 4, 5].map((id) => ({ id, status: 'open' }))
    expect(marksOf({ ...cardOf(3), waitsOn }, nowMs).map((mark) => mark.text)).toEqual(['Waits on #1, #2, #3 +2'])
  })

  it('marks a silent claim with how long it has been quiet', () => {
    const silent = { ...cardOf(9), silent: true, lastSignalAt: new Date(nowMs - 5 * 3_600_000).toISOString() }
    expect(marksOf(silent, nowMs).map((mark) => mark.text)).toEqual(['Silent for 5 h'])
  })

  it('does not mark a silent flag on a task nobody has claimed', () => {
    expect(marksOf({ ...cardOf(1), silent: true }, nowMs)).toEqual([])
  })

  it('marks nothing on a quiet card', () => {
    expect(texts(9)).toEqual([])
    expect(texts(2)).toEqual([])
  })

  it('treats a delivery that is still on its way as information, not a problem', () => {
    const card = cardOf(8)
    const pending = {
      ...card,
      messages: card.messages.map((message) => ({
        ...message,
        deliveries: message.deliveries.map((delivery) => ({ ...delivery, state: 'pending' as const })),
      })),
    }
    expect(marksOf(pending, nowMs).find((mark) => mark.kind === 'undelivered')).toEqual({
      kind: 'undelivered',
      tone: 'quiet',
      text: '1 on the way',
    })
  })
})

describe('threadMarks', () => {
  it('reads every state of the owner thread', () => {
    expect(threadMarks({ question: 'Answered', note: 'NoteRead' }).map((mark) => mark.text)).toEqual([
      'Answer unread',
      'Note read, no reply',
    ])
    expect(threadMarks({ question: 'HandedToLead', note: 'NoNote' }).map((mark) => mark.text)).toEqual([
      'Question with the lead',
    ])
    expect(threadMarks({ question: 'NoAsk', note: 'NoNote' })).toEqual([])
  })
})
