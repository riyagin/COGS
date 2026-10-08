// Stock moves: a grid for entering many stock changes at once, then syncing them.
//   In     stock found or received without a receipt (valued at the given or last unit cost)
//   Out    waste, kitchen use, samples (valued FIFO)
//   Count  a physical count: stock is set to the number entered (opname)
// Rows are kept on this computer until they sync, so nothing is lost when offline.
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../../frontend/src/lib/api'
import { qty, unitRp, today } from '../../../frontend/src/lib/format'
import { Alert, PageHeader, jsonOrThrow } from '../../../frontend/src/components/ui'
import { useMe } from '../../../frontend/src/auth/AuthGate'
import ItemInput from '../components/ItemInput'
import { Spinner } from '../components/bits'
import { newKey, usePersisted } from '../lib/desktop'
import { useReferenceData } from '../lib/data'

const MODES = [
  { value: 'in', label: 'In', cls: 'text-emerald-700' },
  { value: 'out', label: 'Out', cls: 'text-amber-700' },
  { value: 'count', label: 'Count', cls: 'text-indigo-700' },
]
const NOTE_PRESETS = ['Used in kitchen', 'Waste', 'Expired', 'Damaged', 'Sample / tester', 'Staff meal', 'Found in storage', 'Gift / no receipt']

const newRow = (date, mode = 'out') => ({ key: newKey(), mode, item_id: '', qty: '', unit_price: '', note: '', date, status: 'draft', error: '', result: '' })

function rowProblem(r) {
  if (!r.item_id) return 'Choose an item'
  const n = Number(r.qty)
  if (r.qty === '' || isNaN(n) || (r.mode === 'count' ? n < 0 : n <= 0)) return r.mode === 'count' ? 'Enter the counted amount' : 'Enter a quantity above 0'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return 'Set the date'
  return null
}

const isPending = r => r.status === 'draft' || r.status === 'error'
const isBlank = r => !r.item_id && !r.qty && !r.note

export default function StockMoves() {
  const me = useMe()
  const readOnly = me.role === 'viewer'
  const { items, error: loadError, reloadItems } = useReferenceData()
  const [rows, setRows, ready] = usePersisted('stock-moves', [])
  const [date, setDate] = useState(today())
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState({ kind: 'success', text: '' })
  const focusKey = useRef(null)

  // Always keep one empty row at the bottom to type into
  useEffect(() => {
    if (ready && (!rows.length || !isBlank(rows[rows.length - 1]))) {
      setRows(rs => [...rs, newRow(date, rs[rs.length - 1]?.mode)])
    }
  }, [rows, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the item cell of a row added from the keyboard
  useEffect(() => {
    if (!focusKey.current) return
    document.querySelector(`[data-row="${focusKey.current}"] [data-col="item"]`)?.focus()
    focusKey.current = null
  })

  // Editing a failed row makes it a draft again
  const setRow = (key, patch) => setRows(rs => rs.map(r => r.key === key
    ? { ...r, ...(r.status === 'error' ? { status: 'draft', error: '' } : {}), ...patch }
    : r))

  // Stock after the pending rows above, per row, for the "after" column and warnings
  const projections = useMemo(() => {
    const running = new Map(items.map(i => [i.id, Number(i.stock_qty) || 0]))
    const out = new Map()
    for (const r of rows) {
      const id = Number(r.item_id)
      if (!id || !running.has(id) || !isPending(r) || rowProblem(r)) continue
      const before = running.get(id)
      const n = Number(r.qty)
      const after = r.mode === 'in' ? before + n : r.mode === 'out' ? before - n : n
      running.set(id, after)
      out.set(r.key, { before, after })
    }
    return out
  }, [rows, items])

  const pending = rows.filter(r => isPending(r) && !isBlank(r))
  const syncable = pending.filter(r => !rowProblem(r))
  const syncedCount = rows.filter(r => r.status === 'synced').length

  // Paste rows from a spreadsheet: item, quantity, note (tab-separated). A negative quantity
  // is stock out; otherwise rows take the mode of the row pasted into.
  function handlePaste(e, row) {
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.trim().includes('\n')) return
    e.preventDefault()
    const byName = new Map(items.map(i => [i.name.toLowerCase(), i]))
    const unknown = []
    const pasted = text.split(/\r?\n/).map(l => l.split('\t').map(c => c.trim())).filter(c => c[0])
      .map(([name, q = '', note = '']) => {
        const item = byName.get(name.toLowerCase())
        if (!item) unknown.push(name)
        const n = Number(q.replace(/\s/g, '').replace(',', '.'))
        return {
          ...newRow(date, row.mode),
          item_id: item ? String(item.id) : '',
          mode: n < 0 ? 'out' : row.mode,
          qty: q === '' || isNaN(n) ? '' : String(Math.abs(n)),
          note,
        }
      })
    setRows(rs => {
      const at = rs.findIndex(r => r.key === row.key)
      const keep = isBlank(row) ? rs.filter(r => r.key !== row.key) : rs
      const index = isBlank(row) ? at : at + 1
      return [...keep.slice(0, index), ...pasted, ...keep.slice(index)]
    })
    setNotice(unknown.length
      ? { kind: 'error', text: `Pasted ${pasted.length} rows. Not recognised, pick the item by hand: ${unknown.join(', ')}` }
      : { kind: 'success', text: `Pasted ${pasted.length} rows.` })
  }

  function handleKeyDown(e, row) {
    if (e.key !== 'Enter' || e.target.tagName === 'SELECT') return
    e.preventDefault()
    const index = rows.findIndex(r => r.key === row.key)
    const next = rows[index + 1]
    if (next) focusKey.current = next.key
  }

  async function syncAll() {
    setSyncing(true)
    setNotice({ kind: 'success', text: '' })
    let done = 0
    let failed = 0
    for (const row of syncable) {
      setRow(row.key, { status: 'syncing', error: '' })
      const unit_price = row.mode !== 'out' && row.unit_price !== '' ? Number(row.unit_price) : undefined
      try {
        const res = row.mode === 'count'
          ? await apiFetch('/api/adjustments/opname', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: Number(row.item_id), counted_quantity: Number(row.qty), date: row.date, note: row.note || undefined, unit_price }),
          })
          : await apiFetch('/api/adjustments', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: Number(row.item_id), quantity: row.mode === 'in' ? Number(row.qty) : -Number(row.qty), date: row.date, note: row.note || null, unit_price }),
          })
        const data = await jsonOrThrow(res)
        const result = row.mode === 'count'
          ? (data.delta ? `${data.delta > 0 ? '+' : ''}${qty(data.delta)} ${data.unit_type}` : 'no change')
          : ''
        setRows(rs => rs.map(r => r.key === row.key ? { ...r, status: 'synced', error: '', result } : r))
        done++
      } catch (err) {
        // fetch() itself failing means no connection: stop and keep the rest for later
        const offline = err instanceof TypeError
        setRows(rs => rs.map(r => r.key === row.key ? { ...r, status: 'error', error: offline ? 'Not sent: no connection' : err.message } : r))
        failed++
        if (offline) break
      }
    }
    setSyncing(false)
    reloadItems()
    setNotice(failed
      ? { kind: 'error', text: `Synced ${done}, ${failed} failed. Fix the rows marked in red and sync again.` }
      : { kind: 'success', text: `Synced ${done} row${done === 1 ? '' : 's'}.` })
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Stock moves" subtitle="Enter many stock changes at once. They stay on this computer until synced.">
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-600 flex items-center gap-2">
            Date for new rows
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="glass-input px-2 py-1.5 text-sm" />
          </label>
          {syncedCount > 0 && (
            <button type="button" onClick={() => setRows(rs => rs.filter(r => r.status !== 'synced'))}
              className="bg-white/40 text-gray-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/60">
              Clear {syncedCount} synced
            </button>
          )}
          <button type="button" onClick={syncAll} disabled={readOnly || syncing || !syncable.length} className="btn-primary px-5 py-2">
            {syncing ? 'Syncing…' : `Sync ${syncable.length || ''} row${syncable.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </PageHeader>

      {readOnly && <Alert>Your account is read-only, so stock moves can't be synced.</Alert>}
      <Alert>{loadError && `Could not load items from the server: ${loadError}`}</Alert>
      <Alert kind={notice.kind} onClose={() => setNotice({ ...notice, text: '' })}>{notice.text}</Alert>

      <div className="glass-card flex-1 min-h-0 overflow-auto">
        <table className="w-full text-sm table-fixed min-w-[62rem]">
          <colgroup>
            <col className="w-8" /><col className="w-20" /><col /><col className="w-[6.5rem]" /><col className="w-28" />
            <col className="w-[6.5rem]" /><col className="w-36" /><col className="w-[8.75rem]" /><col className="w-28" /><col className="w-7" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white/70 backdrop-blur">
            <tr className="border-b border-white/60 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              <th className="px-1 py-2.5"></th>
              <th className="px-1 py-2.5 text-left">Type</th>
              <th className="px-1 py-2.5 text-left">Item</th>
              <th className="px-1 py-2.5 text-right">Qty</th>
              <th className="px-1 py-2.5 text-right">Stock → after</th>
              <th className="px-1 py-2.5 text-right" title="For In and Count: value of found stock. Empty = last price">Unit cost</th>
              <th className="px-1 py-2.5 text-left">Note</th>
              <th className="px-1 py-2.5 text-left">Date</th>
              <th className="px-1 py-2.5 text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/50">
            {rows.map((row, index) => {
              const item = items.find(i => i.id === Number(row.item_id))
              const locked = row.status === 'synced' || row.status === 'syncing' || readOnly
              const proj = projections.get(row.key)
              const problem = !isBlank(row) && isPending(row) ? rowProblem(row) : null
              const negative = proj && proj.after < -0.0001
              return (
                <tr key={row.key} data-row={row.key} className={row.status === 'synced' ? 'opacity-55' : ''}
                  onKeyDown={e => handleKeyDown(e, row)} onPaste={e => !locked && handlePaste(e, row)}>
                  <td className="px-1 py-1.5 text-xs text-gray-400 text-right">{isBlank(row) ? '' : index + 1}</td>
                  <td className="px-1 py-1.5">
                    <select value={row.mode} disabled={locked} onChange={e => setRow(row.key, { mode: e.target.value })}
                      className={`glass-input px-2 py-1.5 text-sm font-semibold w-full ${MODES.find(m => m.value === row.mode).cls}`}>
                      {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1.5">
                    <ItemInput items={items} value={row.item_id} disabled={locked} data-col="item"
                      onChange={item_id => setRow(row.key, { item_id })}
                      placeholder={isBlank(row) ? 'Type an item or paste rows' : 'Type an item…'} />
                  </td>
                  <td className="px-1 py-1.5">
                    <div className="relative">
                      <input type="number" step="any" min="0" value={row.qty} disabled={locked}
                        onChange={e => setRow(row.key, { qty: e.target.value })}
                        placeholder={row.mode === 'count' ? 'Counted' : 'Qty'}
                        className="w-full glass-input px-2 py-1.5 text-sm text-right pr-9" />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{item?.unit_type}</span>
                    </div>
                  </td>
                  <td className={`px-2 py-1.5 text-right text-xs whitespace-nowrap ${negative ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                    {proj ? `${qty(proj.before)} → ${qty(proj.after)}` : item && row.status !== 'synced' ? qty(item.stock_qty) : ''}
                  </td>
                  <td className="px-1 py-1.5">
                    {row.mode !== 'out' && (
                      <input type="number" step="any" min="0" value={row.unit_price} disabled={locked}
                        onChange={e => setRow(row.key, { unit_price: e.target.value })}
                        placeholder={item?.last_unit_price != null ? unitRp(item.last_unit_price) : 'Rp / unit'}
                        className="w-full glass-input px-2 py-1.5 text-sm text-right" />
                    )}
                  </td>
                  <td className="px-1 py-1.5">
                    <input list="note-presets" value={row.note} disabled={locked}
                      onChange={e => setRow(row.key, { note: e.target.value })} placeholder="Reason"
                      className="w-full glass-input px-2 py-1.5 text-sm" />
                  </td>
                  <td className="px-1 py-1.5">
                    <input type="date" value={row.date} disabled={locked} onChange={e => setRow(row.key, { date: e.target.value })}
                      className="w-full glass-input px-2 py-1.5 text-sm" />
                  </td>
                  <td className="px-1 py-1.5 text-xs truncate">
                    {row.status === 'syncing' && <span className="flex items-center gap-1.5 text-indigo-600"><Spinner className="w-3 h-3" />Syncing</span>}
                    {row.status === 'synced' && <span className="text-emerald-700 font-medium">✓ Synced{row.result ? ` · ${row.result}` : ''}</span>}
                    {row.status === 'error' && <span className="text-red-600" title={row.error}>✗ {row.error}</span>}
                    {row.status === 'draft' && problem && <span className="text-gray-400">{problem}</span>}
                    {row.status === 'draft' && !problem && !isBlank(row) && (
                      <span className={negative ? 'text-red-600' : 'text-gray-500'}>{negative ? 'More than in stock' : 'Ready'}</span>
                    )}
                  </td>
                  <td className="px-1">
                    {!isBlank(row) && row.status !== 'syncing' && (
                      <button type="button" onClick={() => setRows(rs => rs.filter(r => r.key !== row.key))}
                        className="text-gray-400 hover:text-red-500 px-1" aria-label="Remove row">×</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <datalist id="note-presets">{NOTE_PRESETS.map(n => <option key={n} value={n} />)}</datalist>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Out is valued at FIFO cost and booked as waste/adjustment; In uses the unit cost you enter or the last price.
        Paste from Excel or Sheets: columns <em>item, quantity, note</em> (negative quantity = out). Enter moves to the next row.
      </p>
    </div>
  )
}
