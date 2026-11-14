// Search always; role, tag and owner behind a button on a phone and inline on a desktop. Role, tag and owner narrow
// what the server sends; the text narrows what is already here.
import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { Options } from './board-state'
import type { Filters } from './columns'
import { ownerLabel } from './format'

type SelectKey = 'role' | 'tag' | 'owner'

const SELECTS: readonly { key: SelectKey; label: string; any: string; options: (options: Options) => string[] }[] = [
  { key: 'role', label: 'Role', any: 'All roles', options: (options) => options.roles },
  { key: 'tag', label: 'Tag', any: 'All tags', options: (options) => options.tags },
  { key: 'owner', label: 'Owner', any: 'All owners', options: (options) => options.owners },
]

export function FilterBar({
  filters,
  options,
  onChange,
}: {
  filters: Filters
  options: Options
  onChange: (next: Filters) => void
}) {
  const [open, setOpen] = useState(false)
  const active = SELECTS.filter(({ key }) => filters[key] !== '').length
  return (
    <div className='controls' role='search'>
      <div className='search-row'>
        <label className='sr-only' htmlFor='board-search'>
          Search tasks
        </label>
        <input
          id='board-search'
          className='input'
          type='search'
          inputMode='search'
          enterKeyHint='search'
          autoComplete='off'
          placeholder='Search title, #id, role, owner'
          value={filters.text}
          onChange={(event) => onChange({ ...filters, text: event.target.value })}
        />
        <button
          type='button'
          className='button filter-toggle'
          aria-expanded={open}
          aria-controls='board-filter-fields'
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal aria-hidden='true' />
          <span>{active > 0 ? `Filters (${active})` : 'Filters'}</span>
        </button>
      </div>
      <div id='board-filter-fields' className='fields' data-open={open}>
        {SELECTS.map(({ key, label, any, options: pick }) => {
          const values = pick(options)
          // A chosen value always stays listed, even when the view that offered it has moved on.
          const listed = filters[key] === '' || values.includes(filters[key]) ? values : [filters[key], ...values]
          return (
            <label key={key} className='field'>
              <span>{label}</span>
              <select
                className='select'
                value={filters[key]}
                onChange={(event) => onChange({ ...filters, [key]: event.target.value })}
              >
                <option value=''>{any}</option>
                {listed.map((value) => (
                  <option key={value} value={value}>
                    {key === 'owner' ? ownerLabel(value) : value}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
    </div>
  )
}
