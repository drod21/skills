// The one sheet the moves use: the Move to list, the text a move asks for, and the "clear all" confirm. A native
// <dialog>, so focus is trapped, Escape closes it and the page behind is inert without any code of ours.
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ownerLabel } from '../board/format'
import { useMoves, useMovesState, type MovesActions } from './MovesProvider'
import { TARGET_IDS, MAX_INPUT_LENGTH, type MoveOption, type MovesLookup, type TargetId } from './moves-contract'
import type { MoveCard, Sheet } from './moves-state'
import { TARGET_LABEL, canBeCleared, fieldLabel, hintOf, verbOf } from './targets'

function MenuRow({
  card,
  target,
  option,
  onChoose,
}: {
  card: MoveCard
  target: TargetId
  option: MoveOption
  onChoose: () => void
}) {
  const label = target === 'clear' ? 'Clear from the board' : TARGET_LABEL[target]
  if (option.state === 'here') {
    return (
      <li>
        <div className='sheet-row' data-state='here'>
          <Check aria-hidden='true' />
          <span className='sheet-row-text'>
            <span className='sheet-row-label'>{label}</span>
            <span className='sheet-row-note'>Where task {card.id} is now</span>
          </span>
        </div>
      </li>
    )
  }
  const refused = option.state === 'refused'
  return (
    <li>
      <button
        type='button'
        className='sheet-row'
        data-state={refused ? 'refused' : 'legal'}
        data-target={target}
        // A refused move stays focusable so a screen reader hears why; choosing it explains instead of acting.
        aria-disabled={refused}
        onClick={refused ? undefined : onChoose}
      >
        <span className='sheet-row-text'>
          <span className='sheet-row-label'>{label}</span>
          <span className='sheet-row-note'>{refused ? option.reason : hintOf(target, option)}</span>
        </span>
      </button>
    </li>
  )
}

function Menu({ sheet, moves }: { sheet: Extract<Sheet, { kind: 'menu' }>; moves: MovesActions }) {
  const { lookup, card } = sheet
  const ready: MovesLookup | null = lookup.state === 'ready' ? lookup.moves : null
  return (
    <>
      <h2 className='sheet-title'>Move task #{card.id}</h2>
      {card.title && <p className='sheet-sub'>{card.title}</p>}
      {lookup.state === 'loading' && (
        <p className='sheet-sub' role='status'>
          Asking the board what this task can do
        </p>
      )}
      {lookup.state === 'failed' && (
        <p className='sheet-error' role='alert'>
          Cannot read the moves: {lookup.message}
        </p>
      )}
      {ready && (
        <ul className='sheet-list'>
          {TARGET_IDS.filter(
            (target) => target !== 'clear' || (canBeCleared(card) && ready.targets.clear.state !== 'here'),
          ).map((target) => (
            <MenuRow
              key={target}
              card={card}
              target={target}
              option={ready.targets[target]}
              onChoose={() => moves.choose(card, target, ready)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

/** What a cancel or a release takes from the worker who holds the task, said before the owner confirms it. */
function consequenceOf(card: MoveCard, command: string): string | null {
  if (card.status !== 'claimed' || card.owner === null) return null
  const who = ownerLabel(card.owner)
  if (command === 'cancel')
    return `${who} holds this task and may still be working on it. Cancelling closes it under them.`
  if (command === 'release')
    return `${who} holds this task and may still be working on it. Releasing takes their claim away.`
  return null
}

function Form({ sheet, moves }: { sheet: Extract<Sheet, { kind: 'form' }>; moves: MovesActions }) {
  const { card, target, option } = sheet
  const [error, setError] = useState<string | null>(null)
  const verb = verbOf(target, option)
  const consequence = consequenceOf(card, option.command)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const inputs: Record<string, string> = {}
    for (const field of option.fields) {
      const entry = data.get(field.name)
      const value = typeof entry === 'string' ? entry.trim() : ''
      if (value === '' && field.required) {
        setError(`${fieldLabel(option, target, field.name)} Write at least a few words.`)
        return
      }
      if (value !== '') inputs[field.name] = value
    }
    moves.submitForm(inputs)
  }
  return (
    <form onSubmit={submit} noValidate>
      <h2 className='sheet-title'>{verb}</h2>
      <p className='sheet-sub'>
        Task #{card.id}
        {card.title && ` ${card.title}`}
      </p>
      {consequence && <p className='sheet-consequence'>{consequence}</p>}
      {option.fields.map((field, index) => (
        <label key={field.name} className='sheet-field'>
          <span>{fieldLabel(option, target, field.name)}</span>
          <textarea
            name={field.name}
            className='input sheet-input'
            rows={3}
            maxLength={MAX_INPUT_LENGTH}
            defaultValue={field.prefill ?? ''}
            required={field.required}
            autoFocus={index === 0}
            onChange={() => setError(null)}
          />
        </label>
      ))}
      {error && (
        <p className='sheet-error' role='alert'>
          {error}
        </p>
      )}
      <div className='sheet-actions'>
        <button type='button' className='button' onClick={moves.closeSheet}>
          Cancel
        </button>
        <button type='submit' className='button' data-primary='true'>
          {verb}
        </button>
      </div>
    </form>
  )
}

function ClearAll({ sheet, moves }: { sheet: Extract<Sheet, { kind: 'clearAll' }>; moves: MovesActions }) {
  const count = sheet.cards.length
  const noun = `${sheet.column} ${count === 1 ? 'task' : 'tasks'}`
  return (
    <>
      <h2 className='sheet-title'>
        Clear {count} {noun}?
      </h2>
      <p className='sheet-sub'>
        {count === 1 ? 'It leaves' : 'They leave'} the board. Show cleared brings {count === 1 ? 'it' : 'them'} back to
        look at.
      </p>
      <div className='sheet-actions'>
        <button type='button' className='button' onClick={moves.closeSheet}>
          Keep {count === 1 ? 'it' : 'them'}
        </button>
        <button type='button' className='button' data-primary='true' onClick={moves.confirmClearAll}>
          Clear {count} {count === 1 ? 'task' : 'tasks'}
        </button>
      </div>
    </>
  )
}

export function MoveSheet() {
  const moves = useMoves()
  const { sheet } = useMovesState()
  const dialog = useRef<HTMLDialogElement>(null)
  const open = sheet !== null
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])
  if (moves === null) return null
  return (
    <dialog
      ref={dialog}
      className='sheet'
      aria-label={sheet?.kind === 'clearAll' ? 'Clear tasks' : 'Move a task'}
      onCancel={(event) => {
        event.preventDefault()
        moves.closeSheet()
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; the panel is its only child.
        if (event.target === dialog.current) moves.closeSheet()
      }}
    >
      {sheet && (
        <div className='sheet-panel' data-kind={sheet.kind}>
          <button type='button' className='sheet-close' aria-label='Close' onClick={moves.closeSheet}>
            <X aria-hidden='true' />
          </button>
          {sheet.kind === 'menu' && <Menu sheet={sheet} moves={moves} />}
          {sheet.kind === 'form' && <Form key={`${sheet.card.id}-${sheet.target}`} sheet={sheet} moves={moves} />}
          {sheet.kind === 'clearAll' && <ClearAll sheet={sheet} moves={moves} />}
        </div>
      )}
    </dialog>
  )
}
