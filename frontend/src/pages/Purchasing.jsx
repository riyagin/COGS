import { useState, useEffect, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import { rp, qty, unitRp, today } from '../lib/format'
import { Alert, ItemSelect, PageHeader, SectionTitle, Tabs, inputCls, labelCls, thCls, jsonOrThrow } from '../components/ui'

const newLine = (kind = 'item') => ({ kind, item_id: '', quantity: '', amount: '', account_id: '', description: '' })
const emptyForm = () => ({ date: today(), supplier: '', reference: '', note: '', payment: 'cash', lines: [newLine()] })

const PAYMENT_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'unpaid', label: 'Unpaid' },
]

function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-white/70 bg-white/40 p-0.5">
      {options.map(o => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${value === o.value ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-900'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// One stock line with the last-price hint
function ItemLine({ line, items, onChange }) {
  const item = items.find(i => i.id === Number(line.item_id))
  const lastUnit = item?.last_unit_price ?? null
  const q = Number(line.quantity)
  const unitPrice = q > 0 && Number(line.amount) > 0 ? Number(line.amount) / q : null
  const suggested = lastUnit != null && q > 0 ? Math.round(lastUnit * q) : null
  const change = lastUnit && unitPrice ? (unitPrice - lastUnit) / lastUnit : null

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-[1fr_8rem_9rem] gap-2">
        <div className="col-span-2 sm:col-span-1">
          <ItemSelect items={items} value={line.item_id} onChange={v => onChange({ item_id: v })} />
        </div>
        <div className="relative">
          <input type="number" step="any" min="0" placeholder="Qty" value={line.quantity}
            onChange={e => onChange({ quantity: e.target.value })} className={`${inputCls} pr-10`} required />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{item?.unit_type}</span>
        </div>
        <input type="number" step="any" min="0" placeholder={suggested != null ? `≈ ${qty(suggested)}` : 'Total Rp'}
          value={line.amount} onChange={e => onChange({ amount: e.target.value })} className={inputCls} required />
      </div>
      {(lastUnit != null || unitPrice) && (
        <p className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-2">
          {unitPrice && <span>{unitRp(unitPrice)}/{item?.unit_type}</span>}
          {lastUnit != null && (
            <span>last {item.last_price_source === 'purchase' ? 'price' : 'cost'} {unitRp(lastUnit)}/{item.unit_type} · {item.last_price_date}</span>
          )}
          {suggested != null && !line.amount && (
            <button type="button" onClick={() => onChange({ amount: String(suggested) })} className="font-medium text-indigo-600 hover:text-indigo-800">
              Use last price
            </button>
          )}
          {change != null && Math.abs(change) >= 0.005 && (
            <span className={`font-medium ${change > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {change > 0 ? '▲' : '▼'} {Math.abs(change * 100).toFixed(1)}% vs last
            </span>
          )}
        </p>
      )}
    </>
  )
}

function ExpenseLine({ line, accounts, onChange }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-[14rem_1fr_9rem] gap-2">
      <select value={line.account_id} onChange={e => onChange({ account_id: e.target.value })} className={`${inputCls} col-span-2 sm:col-span-1`} required>
        <option value="">Expense type</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <input placeholder="What for (optional)" value={line.description} onChange={e => onChange({ description: e.target.value })} className={inputCls} />
      <input type="number" step="any" min="0" placeholder="Total Rp" value={line.amount} onChange={e => onChange({ amount: e.target.value })} className={inputCls} required />
    </div>
  )
}

function PurchaseForm({ items, accounts, suppliers, onSaved }) {
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const setLine = (idx, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, ...patch } : l) }))
  const total = form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const body = {
        ...form,
        lines: form.lines.map(l => l.kind === 'item'
          ? { item_id: Number(l.item_id), quantity: Number(l.quantity), amount: Number(l.amount) }
          : { account_id: Number(l.account_id), description: l.description, amount: Number(l.amount) }),
      }
      const saved = await jsonOrThrow(await apiFetch('/api/purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
      setForm(f => ({ ...emptyForm(), date: f.date, payment: f.payment }))
      onSaved(saved)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr_10rem] gap-3">
        <div>
          <label className={labelCls}>Date</label>
          <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Supplier</label>
          <input list="supplier-list" value={form.supplier} onChange={e => setForm({ ...form, supplier: e.target.value })}
            className={inputCls} placeholder="e.g. Pasar Baru, Toko Sinar" />
          <datalist id="supplier-list">{suppliers.map(s => <option key={s} value={s} />)}</datalist>
        </div>
        <div>
          <label className={labelCls}>Receipt / ref no.</label>
          <input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} className={inputCls} placeholder="optional" />
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">What was bought</span>
        <div className="mt-2 space-y-3">
          {form.lines.map((line, idx) => (
            <div key={idx} className="rounded-xl border border-white/60 bg-white/25 p-3">
              <div className="flex items-center justify-between mb-2">
                <Segmented
                  value={line.kind}
                  onChange={kind => setLine(idx, { ...newLine(kind) })}
                  options={[{ value: 'item', label: 'Stock item' }, { value: 'expense', label: 'Expense' }]}
                />
                {form.lines.length > 1 && (
                  <button type="button" onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))}
                    className="text-gray-400 hover:text-red-500 text-lg leading-none px-1" aria-label="Remove line">×</button>
                )}
              </div>
              {line.kind === 'item'
                ? <ItemLine line={line} items={items} onChange={patch => setLine(idx, patch)} />
                : <ExpenseLine line={line} accounts={accounts} onChange={patch => setLine(idx, patch)} />}
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4">
          <button type="button" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, newLine('item')] }))}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">+ Stock item</button>
          <button type="button" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, newLine('expense')] }))}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">+ Expense (gas, delivery, …)</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-white/50">
        <div>
          <span className="block text-xs font-medium text-gray-600 mb-1">Paid with</span>
          <Segmented options={PAYMENT_OPTIONS} value={form.payment} onChange={payment => setForm({ ...form, payment })} />
        </div>
        <div className="ml-auto text-right">
          <p className="text-xs text-gray-500">Total</p>
          <p className="text-lg font-bold text-gray-800">{rp(total)}</p>
        </div>
        <button type="submit" disabled={saving} className="btn-primary px-6 py-2.5">{saving ? 'Saving…' : 'Record Purchase'}</button>
      </div>
      {form.payment === 'unpaid' && (
        <p className="text-xs text-amber-700">Stock is added now; the bill stays open under “Unpaid” until you mark it paid.</p>
      )}
    </form>
  )
}

function PayControl({ purchase, onPaid }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(today())
  const [payment, setPayment] = useState('cash')
  const [busy, setBusy] = useState(false)

  if (!open) return <button onClick={() => setOpen(true)} className="text-xs font-semibold text-emerald-600 hover:text-emerald-800">Mark paid</button>

  async function pay() {
    setBusy(true)
    try {
      onPaid(await jsonOrThrow(await apiFetch(`/api/purchases/${purchase.id}/pay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, payment }),
      })))
    } catch (err) { alert(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 justify-end">
      <input type="date" value={date} onChange={e => setDate(e.target.value)} className="glass-input px-2 py-1 text-xs" />
      <select value={payment} onChange={e => setPayment(e.target.value)} className="glass-input px-2 py-1 text-xs">
        <option value="cash">Cash</option>
        <option value="bank">Bank</option>
      </select>
      <button onClick={pay} disabled={busy} className="btn-primary px-3 py-1 text-xs">Pay {rp(purchase.total)}</button>
      <button onClick={() => setOpen(false)} className="text-xs text-gray-500">Cancel</button>
    </div>
  )
}

export default function Purchasing() {
  const [purchases, setPurchases] = useState([])
  const [items, setItems] = useState([])
  const [accounts, setAccounts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [expanded, setExpanded] = useState(null)
  const [success, setSuccess] = useState('')

  const loadPurchases = () => apiFetch('/api/purchases').then(r => r.json()).then(data => { setPurchases(data); setLoading(false) })
  const loadItems = () => apiFetch('/api/items').then(r => r.json()).then(setItems)
  const loadSuppliers = () => apiFetch('/api/purchases/suppliers').then(r => r.json()).then(setSuppliers)

  useEffect(() => {
    loadPurchases()
    loadItems()
    loadSuppliers()
    apiFetch('/api/accounting/accounts').then(r => r.json()).then(all =>
      setAccounts(all.filter(a => a.active && (['expense', 'cogs'].includes(a.type) || (a.type === 'asset' && !a.system_key)))))
  }, [])

  function handleSaved(p) {
    setPurchases(prev => [p, ...prev])
    setSuccess(`Recorded ${rp(p.total)}${p.supplier ? ` from ${p.supplier}` : ''}${p.paid_date ? '' : ' as unpaid'}.`)
    loadItems() // new last prices
    loadSuppliers()
  }

  async function handleDelete(p) {
    if (!confirm(`Delete this purchase of ${rp(p.total)}? Its stock and bookkeeping entries are removed too.`)) return
    try {
      await jsonOrThrow(await apiFetch(`/api/purchases/${p.id}`, { method: 'DELETE' }))
      setPurchases(prev => prev.filter(x => x.id !== p.id))
      loadItems()
    } catch (err) { alert(err.message) }
  }

  const unpaid = purchases.filter(p => !p.paid_date)
  const unpaidTotal = unpaid.reduce((s, p) => s + p.total, 0)
  const visible = useMemo(() => tab === 'unpaid' ? unpaid : purchases, [tab, purchases]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Purchasing" subtitle="Record what you buy: stock goes into inventory, everything goes into the books" />

      <div className="glass-card p-4 sm:p-6 mb-6">
        <SectionTitle className="mb-4">New Purchase</SectionTitle>
        <Alert kind="success" onClose={() => setSuccess('')}>{success}</Alert>
        <PurchaseForm items={items} accounts={accounts} suppliers={suppliers} onSaved={handleSaved} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'all', label: 'All purchases', count: purchases.length },
          { value: 'unpaid', label: 'Unpaid', count: unpaid.length },
        ]} />
        {unpaidTotal > 0 && <p className="text-sm text-amber-700 mb-4">Owed to suppliers: <strong>{rp(unpaidTotal)}</strong></p>}
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tab === 'unpaid' ? 'Nothing unpaid.' : 'No purchases yet.'}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className={`${thCls} text-left`}>Date</th>
                <th className={`${thCls} text-left`}>Supplier</th>
                <th className={`${thCls} text-left`}>Lines</th>
                <th className={`${thCls} text-right`}>Total</th>
                <th className={`${thCls} text-left`}>Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {visible.map(p => {
                const stockLines = p.lines.filter(l => l.item_id)
                const expenseLines = p.lines.filter(l => l.account_id)
                return [
                  <tr key={p.id} className="hover:bg-white/40 cursor-pointer" onClick={() => setExpanded(e => e === p.id ? null : p.id)}>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      <span className="mr-2 text-gray-400">{expanded === p.id ? '▾' : '▸'}</span>{p.date}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {p.supplier || '—'}{p.reference && <span className="ml-2 text-xs text-gray-400">#{p.reference}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-[18rem] truncate">
                      {[...stockLines.map(l => l.item_name), ...expenseLines.map(l => l.description || l.account_name)].join(', ')}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800">{rp(p.total)}</td>
                    <td className="px-4 py-3">
                      {p.paid_date
                        ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Paid · {p.paid_from_name}</span>
                        : <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Unpaid</span>}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                      {!p.paid_date && <PayControl purchase={p} onPaid={paid => setPurchases(prev => prev.map(x => x.id === paid.id ? paid : x))} />}
                    </td>
                  </tr>,
                  expanded === p.id && (
                    <tr key={`${p.id}-d`} className="bg-indigo-50/50">
                      <td colSpan={6} className="px-6 py-4">
                        <table className="w-full text-xs">
                          <tbody>
                            {p.lines.map(l => (
                              <tr key={l.id} className="border-b border-indigo-100/70 last:border-0">
                                <td className="py-1.5 text-gray-700">
                                  {l.item_id ? l.item_name : <>{l.account_name}{l.description && <span className="text-gray-500"> — {l.description}</span>}</>}
                                </td>
                                <td className="py-1.5 text-right text-gray-600">{l.item_id ? `${qty(l.quantity)} ${l.unit_type}` : 'expense'}</td>
                                <td className="py-1.5 text-right text-gray-500">{l.item_id && l.quantity > 0 ? `${unitRp(l.amount / l.quantity)}/${l.unit_type}` : ''}</td>
                                <td className="py-1.5 text-right text-gray-700 font-medium">{rp(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                          <span>
                            Recorded by {p.created_by_name || '—'}
                            {p.paid_date && p.paid_date !== p.date && ` · paid ${p.paid_date}`}
                          </span>
                          {p.stock_used
                            ? <span title="Correct it with a stock adjustment instead">Stock already used — can't delete</span>
                            : <button onClick={() => handleDelete(p)} className="text-red-400 hover:text-red-600 font-medium">Delete purchase</button>}
                        </div>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
