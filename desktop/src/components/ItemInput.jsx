// Type-to-search item picker for fast keyboard entry. Typing an item's exact name (any case)
// or choosing it from the suggestions selects it; anything else leaves no item selected.
import { useEffect, useId, useState } from 'react'

export default function ItemInput({ items, value, onChange, className = '', placeholder = 'Type an item…', ...rest }) {
  const listId = useId()
  const selected = items.find(i => i.id === Number(value))
  const [text, setText] = useState(selected?.name || '')

  // Follow an item chosen elsewhere (matching, paste). Clearing the selection keeps the
  // text, since that happens while the user is still typing.
  useEffect(() => {
    if (!selected) return
    setText(current => current.trim().toLowerCase() === selected.name.toLowerCase() ? current : selected.name)
  }, [selected?.id, selected?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  function handle(next) {
    setText(next)
    const match = items.find(i => i.name.toLowerCase() === next.trim().toLowerCase())
    const id = match ? String(match.id) : ''
    if (id !== String(value || '')) onChange(id)
  }

  const invalid = text.trim() && !selected
  return (
    <>
      <input
        list={listId}
        value={text}
        onChange={e => handle(e.target.value)}
        placeholder={placeholder}
        className={`w-full glass-input px-2 py-1.5 text-sm focus:ring-2 focus:ring-indigo-400/60 ${invalid ? '!border-red-300 !bg-red-50/60' : ''} ${className}`}
        title={invalid ? 'No item with this name. Pick one from the list.' : selected ? `${selected.name} (${selected.unit_type})` : ''}
        {...rest}
      />
      <datalist id={listId}>
        {items.map(i => <option key={i.id} value={i.name}>{i.unit_type}</option>)}
      </datalist>
    </>
  )
}
