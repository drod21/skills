// The row under a closed column's heading: clear everything in view, and bring cleared tasks back into sight.
import { Archive, Eye, EyeOff } from 'lucide-react'
import type { BoardCard } from '../board/board-contract'
import { useMoves } from './MovesProvider'

export function ColumnTools({
  column,
  cards,
  showCleared,
  hasCleared,
}: {
  column: 'done' | 'cancelled'
  cards: readonly BoardCard[]
  showCleared: boolean
  hasCleared: boolean
}) {
  const moves = useMoves()
  const clearable = cards.filter((card) => !card.archived)
  if (moves === null || (clearable.length === 0 && !hasCleared)) return null
  return (
    <div className='column-tools'>
      {clearable.length > 0 && (
        <button
          type='button'
          className='button column-tool'
          disabled={!moves.canMove}
          onClick={() => moves.askClearAll(column, clearable)}
        >
          <Archive aria-hidden='true' />
          <span>Clear all {column}</span>
          <span className='num column-tool-count'>{clearable.length}</span>
        </button>
      )}
      {hasCleared && (
        <button type='button' className='button column-tool' aria-pressed={showCleared} onClick={moves.toggleCleared}>
          {showCleared ? <EyeOff aria-hidden='true' /> : <Eye aria-hidden='true' />}
          <span>{showCleared ? 'Hide cleared' : 'Show cleared'}</span>
        </button>
      )}
    </div>
  )
}
