// The two buttons under a card. "Move to" is the whole of drag and drop without a drag: it works with a tap, a
// keyboard and a screen reader. "Clear" takes a finished task off the board. Both sit above the card's stretched link.
import { Archive, ArrowRightLeft } from 'lucide-react'
import type { BoardCard } from '../board/board-contract'
import { useMoves } from './MovesProvider'
import { canBeCleared } from './targets'

export function CardMoveControls({ card }: { card: BoardCard }) {
  const moves = useMoves()
  if (moves === null) return null
  if (card.archived) return <p className='card-cleared'>Cleared from the board</p>
  const closed = canBeCleared(card)
  return (
    <div className='card-actions'>
      <button
        type='button'
        className='button card-action'
        disabled={!moves.canMove}
        title='Move to'
        onClick={() => moves.openMenu(card)}
      >
        <ArrowRightLeft aria-hidden='true' />
        <span className='card-action-label'>Move to</span>
        <span className='sr-only'> (task {card.id})</span>
      </button>
      {closed && (
        <button
          type='button'
          className='button card-action'
          disabled={!moves.canMove}
          title='Clear'
          onClick={() => moves.clearOne(card)}
        >
          <Archive aria-hidden='true' />
          <span className='card-action-label'>Clear</span>
          <span className='sr-only'> (task {card.id})</span>
        </button>
      )}
    </div>
  )
}
