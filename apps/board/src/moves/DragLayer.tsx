// What floats over the board: the line that says what a drop would do, the Clear zone, and the one notice (a refusal,
// a stale card, a failed move). All of it is text, so it is spoken as well as seen. Rendered once, at the page root.
import { Archive, X } from 'lucide-react'
import { useEffect } from 'react'
import { dropStateOf, useMoves, useMovesState } from './MovesProvider'
import type { MoveOption } from './moves-contract'
import { TARGET_LABEL, canBeCleared, hintOf, verbOf } from './targets'

const NOTICE_MS = { info: 4_000, error: 10_000 }

function dockLine(drag: NonNullable<ReturnType<typeof useMovesState>['drag']>): string {
  if (drag.lookup.state === 'loading') return `Task ${drag.card.id} lifted. Asking the board where it can go`
  if (drag.lookup.state === 'failed') return `Cannot read the moves: ${drag.lookup.message}`
  if (drag.over === null) return `Task ${drag.card.id} lifted. Drop it on a column`
  const option: MoveOption = drag.lookup.moves.targets[drag.over]
  const label: string = drag.over === 'clear' ? 'Clear' : TARGET_LABEL[drag.over]
  if (option.state === 'here') return `Task ${drag.card.id} is already in ${label}`
  if (option.state === 'refused') return `${label}: ${option.reason}`
  return `${verbOf(drag.over, option)}: ${hintOf(drag.over, option)}`
}

export function DragLayer() {
  const moves = useMoves()
  const { drag, notice } = useMovesState()
  const noticeKey = notice?.key
  const tone = notice?.tone
  const dismiss = moves?.dismissNotice
  useEffect(() => {
    if (noticeKey === undefined || tone === undefined) return
    const timer = setTimeout(() => dismiss?.(), NOTICE_MS[tone])
    return () => clearTimeout(timer)
  }, [noticeKey, tone, dismiss])
  if (moves === null) return null
  const clear = dropStateOf(drag, 'clear')
  return (
    <div className='drag-layer'>
      {notice && (
        <div
          className='notice'
          data-tone={notice.tone}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          key={notice.key}
        >
          <p>{notice.text}</p>
          <button type='button' className='notice-close' aria-label='Dismiss' onClick={moves.dismissNotice}>
            <X aria-hidden='true' />
          </button>
        </div>
      )}
      {drag && (
        <div className='dock' data-drag-dock='true'>
          <p className='dock-line' role='status'>
            {dockLine(drag)}
          </p>
          {clear.mark !== 'here' && canBeCleared(drag.card) && (
            <div className='dock-clear' data-drop-target='clear' data-drop={clear.mark} data-over={clear.over}>
              <Archive aria-hidden='true' />
              <span>Clear</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
