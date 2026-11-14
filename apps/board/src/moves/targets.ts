// Where a card can go, in the words the page uses for it. One table: the columns, the Clear target, what each move
// is called on a button, and which target a card's own column is.
import type { BoardCard } from '../board/board-contract'
import type { ColumnId } from '../board/columns'
import type { MoveOption, TargetId } from './moves-contract'

export const TARGET_LABEL: Record<TargetId, string> = {
  open: 'Open',
  claimed: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
  clear: 'Clear',
}

/** The four targets that are columns. Needs me is a list of reasons, not a place a card can be moved to. */
const COLUMN_TARGET: Partial<Record<ColumnId, TargetId>> = {
  open: 'open',
  progress: 'claimed',
  done: 'done',
  cancelled: 'cancelled',
}

export const targetOfColumn = (column: ColumnId): TargetId | null => COLUMN_TARGET[column] ?? null

/**
 * Whether Clear is a move this card has. The board clears only finished work (`archive`); for live work its Clear is
 * a plain cancel, which the Cancelled target already is, so the page offers no second, misleading way to say it.
 */
export const canBeCleared = (card: { status: string }): boolean => card.status === 'done' || card.status === 'cancelled'

/** The target whose column shows this card now. An unknown status is drawn in Open or Done, so it counts as those. */
export function ownTarget(card: Pick<BoardCard, 'status'>): TargetId {
  if (card.status === 'claimed') return 'claimed'
  if (card.status === 'cancelled') return 'cancelled'
  if (card.status === 'done') return 'done'
  return 'open'
}

/** What a legal move is called on its button, from the command the board will run. */
export function verbOf(target: TargetId, option: Extract<MoveOption, { state: 'legal' }>): string {
  switch (option.command) {
    case 'release':
      return 'Release'
    case 'cancel':
      return 'Cancel task'
    case 'done':
      return 'Mark done'
    case 'archive':
      return 'Clear'
    case 'note':
      return target === 'claimed' ? 'Ask the lead to start' : 'Reopen'
    default:
      return option.command
  }
}

/** A line saying what the move does, for the Move to list. */
export function hintOf(target: TargetId, option: Extract<MoveOption, { state: 'legal' }>): string {
  switch (option.command) {
    case 'release':
      return 'Releases the claim so another worker can take it'
    case 'cancel':
      return 'Cancels the task with a reason'
    case 'done':
      return 'Marks it done if the board agrees'
    case 'archive':
      return 'Takes it off the board'
    case 'note':
      return target === 'claimed' ? 'Sends the lead a note to start it' : 'Reopens it with a note to the lead'
    default:
      return 'Runs the board command'
  }
}

/** The label above an input, from what the move does with it. */
export function fieldLabel(option: Extract<MoveOption, { state: 'legal' }>, target: TargetId, name: string): string {
  if (option.command === 'note') return target === 'claimed' ? 'Note to the lead' : 'Why is it coming back?'
  if (option.command === 'cancel') return 'Why is it cancelled?'
  if (option.command === 'release') return 'Why is it released? (optional)'
  return name.charAt(0).toUpperCase() + name.slice(1)
}
