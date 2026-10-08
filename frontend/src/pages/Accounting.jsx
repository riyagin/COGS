import { useState, useEffect, useMemo, Fragment } from 'react'
import { apiFetch } from '../lib/api'
import { rp, rpSigned, today } from '../lib/format'
import { Alert, MoneyInput, PageHeader, SectionTitle, Tabs, inputCls, labelCls, thCls, secondaryBtn, jsonOrThrow } from '../components/ui'

const TYPE_LABEL = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity',
  revenue: 'Revenue', cogs: 'Cost of goods sold', expense: 'Expenses',
}

const SOURCE_LABEL = {
  purchase: 'Purchase', purchase_payment: 'Bill payment', production: 'Production', invoice: 'Sale',
  adjustment: 'Stock adjustment', reset: 'Stock reset', opening: 'Opening balance', manual: 'Manual',
  expense: 'Expense', expense_payment: 'Expense payment', pos_sale: 'Café sale',
}

// ── Journal ──────────────────────────────────────────────────────────────────

// Quick entries for the usual non-stock money movements; "custom" is full double entry
const TEMPLATES = {
  expense: { label: 'Pay an expense (rent, wages, electricity…)' },
  capital: { label: 'Owner puts in capital' },
  drawing: { label: 'Owner takes money out' },
  transfer: { label: 'Move money between cash and bank' },
  custom: { label: 'Custom entry (debits and credits)' },
}

function EntryForm({ accounts, onSaved, onCancel }) {
  const [kind, setKind] = useState('expense')
  const [date, setDate] = useState(today())
  const [memo, setMemo] = useState('')
  const [amount, setAmount] = useState('')
  const [expenseId, setExpenseId] = useState('')
  const [money, setMoney] = useState('cash') // cash | bank
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }])
  const [error, setError] = useState('')

  const byKey = key => accounts.find(a => a.system_key === key)
  const active = accounts.filter(a => a.active)
  const expenses = active.filter(a => a.type === 'expense' || a.type === 'cogs')

  function buildLines() {
    const a = Number(amount)
    const cashAcc = byKey(money)
    const other = byKey(money === 'cash' ? 'bank' : 'cash')
    switch (kind) {
      case 'expense': return [{ account_id: Number(expenseId), debit: a }, { account_id: cashAcc.id, credit: a }]
      case 'capital': return [{ account_id: cashAcc.id, debit: a }, { account_id: byKey('capital').id, credit: a }]
      case 'drawing': return [{ account_id: byKey('capital').id, debit: a }, { account_id: cashAcc.id, credit: a }]
      case 'transfer': return [{ account_id: other.id, debit: a }, { account_id: cashAcc.id, credit: a }]
      default: return lines.map(l => ({ account_id: Number(l.account_id), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }))
    }
  }

  const debits = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
  const credits = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      const body = { date, memo: memo || TEMPLATES[kind].label, lines: buildLines() }
      await jsonOrThrow(await apiFetch('/api/accounting/journal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
      onSaved()
    } catch (err) { setError(err.message) }
  }

  const setLine = (i, patch) => setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))

  return (
    <form onSubmit={submit} className="space-y-4">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem] gap-3">
        <div>
          <label className={labelCls}>What happened</label>
          <select value={kind} onChange={e => setKind(e.target.value)} className={inputCls}>
            {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
          </select>
        </div>
        <div><label className={labelCls}>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} required /></div>
      </div>

      {kind !== 'custom' ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {kind === 'expense' && (
            <div>
              <label className={labelCls}>Expense</label>
              <select value={expenseId} onChange={e => setExpenseId(e.target.value)} className={inputCls} required>
                <option value="">Select</option>
                {expenses.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls}>{kind === 'capital' ? 'Into' : kind === 'transfer' ? 'From' : 'Paid from'}</label>
            <select value={money} onChange={e => setMoney(e.target.value)} className={inputCls}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Amount (Rp)</label>
            <MoneyInput value={amount} onChange={setAmount} required />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem_7rem_1.5rem] gap-2 items-center">
              <select value={l.account_id} onChange={e => setLine(i, { account_id: e.target.value })} className={inputCls} required>
                <option value="">Account</option>
                {['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'].map(t => (
                  <optgroup key={t} label={TYPE_LABEL[t]}>
                    {active.filter(a => a.type === t).map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <MoneyInput placeholder="Debit" value={l.debit} onChange={v => setLine(i, { debit: v, credit: '' })} />
              <MoneyInput placeholder="Credit" value={l.credit} onChange={v => setLine(i, { credit: v, debit: '' })} />
              {lines.length > 2 ? <button type="button" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">×</button> : <span />}
            </div>
          ))}
          <div className="flex items-center justify-between text-xs">
            <button type="button" onClick={() => setLines(ls => [...ls, { account_id: '', debit: '', credit: '' }])} className="text-indigo-600 font-semibold">+ Line</button>
            <span className={Math.abs(debits - credits) < 0.005 ? 'text-emerald-600' : 'text-red-500'}>
              Debits {rp(debits)} · Credits {rp(credits)}{Math.abs(debits - credits) >= 0.005 && ` · off by ${rp(Math.abs(debits - credits))}`}
            </span>
          </div>
        </div>
      )}

      <div><label className={labelCls}>Note</label><input value={memo} onChange={e => setMemo(e.target.value)} className={inputCls} placeholder={TEMPLATES[kind].label} /></div>
      <div className="flex gap-3">
        <button type="submit" className="btn-primary px-5 py-2">Save Entry</button>
        <button type="button" onClick={onCancel} className={secondaryBtn}>Cancel</button>
      </div>
    </form>
  )
}

function Journal({ accounts }) {
  const [entries, setEntries] = useState([])
  const [filters, setFilters] = useState({ from: '', to: '', account_id: '', source_type: '' })
  const [adding, setAdding] = useState(false)

  const load = () => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
    apiFetch(`/api/accounting/journal?${params}`).then(r => r.json()).then(setEntries)
  }
  useEffect(load, [filters]) // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(e) {
    if (!confirm('Delete this entry?')) return
    try {
      await jsonOrThrow(await apiFetch(`/api/accounting/journal/${e.id}`, { method: 'DELETE' }))
      load()
    } catch (err) { alert(err.message) }
  }

  return (
    <div>
      {adding ? (
        <div className="glass-card ring-1 ring-indigo-300/60 p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4 !text-indigo-600">New Journal Entry</SectionTitle>
          <EntryForm accounts={accounts} onSaved={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="btn-primary px-4 py-2 mb-4">+ New Entry</button>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        <input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} className="glass-input px-2 py-1.5 text-sm" title="From" />
        <input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} className="glass-input px-2 py-1.5 text-sm" title="To" />
        <select value={filters.account_id} onChange={e => setFilters({ ...filters, account_id: e.target.value })} className="glass-input px-2 py-1.5 text-sm">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
        </select>
        <select value={filters.source_type} onChange={e => setFilters({ ...filters, source_type: e.target.value })} className="glass-input px-2 py-1.5 text-sm">
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="glass-card overflow-hidden">
        {entries.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No entries.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className={`${thCls} text-left`}>Date</th>
                <th className={`${thCls} text-left`}>Account</th>
                <th className={`${thCls} text-right`}>Debit</th>
                <th className={`${thCls} text-right`}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <Fragment key={e.id}>
                  <tr className="border-t border-white/70 bg-white/20">
                    <td className="px-4 pt-2.5 pb-1 text-gray-500 whitespace-nowrap align-top">{e.date}</td>
                    <td colSpan={3} className="px-4 pt-2.5 pb-1">
                      <span className="font-medium text-gray-800">{e.memo || '—'}</span>
                      <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-600">{SOURCE_LABEL[e.source_type] || e.source_type}</span>
                      {e.created_by_name && <span className="ml-2 text-xs text-gray-400">by {e.created_by_name}</span>}
                      {e.source_type === 'manual' && <button onClick={() => remove(e)} className="ml-3 text-xs text-red-400 hover:text-red-600">Delete</button>}
                    </td>
                  </tr>
                  {e.lines.map(l => (
                    <tr key={l.id}>
                      <td></td>
                      <td className={`px-4 py-1 text-gray-600 ${l.credit > 0 ? 'pl-10' : ''}`}>{l.account_code} {l.account_name}{l.memo && <span className="text-gray-400"> — {l.memo}</span>}</td>
                      <td className="px-4 py-1 text-right text-gray-700 whitespace-nowrap">{l.debit > 0 ? rp(l.debit) : ''}</td>
                      <td className="px-4 py-1 text-right text-gray-700 whitespace-nowrap">{l.credit > 0 ? rp(l.credit) : ''}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Chart of accounts ────────────────────────────────────────────────────────

function Accounts({ accounts, reload }) {
  const [form, setForm] = useState({ name: '', type: 'expense' })
  const [error, setError] = useState('')
  const [added, setAdded] = useState('')
  const [editing, setEditing] = useState(null)

  async function add(e) {
    e.preventDefault()
    setError('')
    setAdded('')
    try {
      const account = await jsonOrThrow(await apiFetch('/api/accounting/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }))
      setForm({ name: '', type: form.type })
      setAdded(`Added ${account.code} ${account.name}`)
      reload()
    } catch (err) { setError(err.message) }
  }

  async function patch(a, body) {
    try {
      await jsonOrThrow(await apiFetch(`/api/accounting/accounts/${a.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))
      setEditing(null)
      reload()
    } catch (err) { alert(err.message) }
  }

  return (
    <div>
      <div className="glass-card p-4 sm:p-6 mb-5">
        <SectionTitle className="mb-4">Add Account</SectionTitle>
        <Alert onClose={() => setError('')}>{error}</Alert>
        <Alert kind="success" onClose={() => setAdded('')}>{added}</Alert>
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_12rem_auto] gap-3 items-end">
          <div><label className={labelCls}>Name</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Marketing" required /></div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className={inputCls}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary px-5 py-2">Add</button>
        </form>
        <p className="mt-3 text-xs text-gray-500">
          Account numbers are 6 digits and given automatically. The first digit is the type: 1 assets, 2 liabilities,
          3 equity, 4 revenue, 5 cost of goods sold, 6 expenses.
        </p>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/30 border-b border-white/60">
              <th className={`${thCls} text-left w-24`}>No.</th>
              <th className={`${thCls} text-left`}>Account</th>
              <th className={`${thCls} text-right`}>Balance</th>
              <th className="px-4 py-3 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(TYPE_LABEL).map(type => (
              <Fragment key={type}>
                <tr className="bg-white/30"><td colSpan={4} className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">{TYPE_LABEL[type]}</td></tr>
                {accounts.filter(a => a.type === type).map(a => (
                  <tr key={a.id} className={`border-t border-white/40 ${a.active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-2 text-gray-500 tabular-nums">
                      {editing?.id === a.id ? (
                        <input value={editing.code} onChange={e => setEditing({ ...editing, code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                          className="glass-input px-2 py-1 text-sm w-20 tabular-nums" inputMode="numeric" aria-label="Account number" />
                      ) : a.code}
                    </td>
                    <td className="px-4 py-2 text-gray-800">
                      {editing?.id === a.id ? (
                        <input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') patch(a, { name: editing.name, code: editing.code }); if (e.key === 'Escape') setEditing(null) }}
                          className="glass-input px-2 py-1 text-sm w-full" />
                      ) : a.name}
                      {a.system_key && <span className="ml-2 text-[11px] text-gray-400" title="Posted to automatically by the app">auto</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700 whitespace-nowrap">{rpSigned(a.balance)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {editing?.id === a.id ? (
                        <button onClick={() => patch(a, { name: editing.name, code: editing.code })} className="text-xs text-indigo-600 font-medium">Save</button>
                      ) : (
                        <button onClick={() => setEditing({ id: a.id, name: a.name, code: a.code })} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">Edit</button>
                      )}
                      {!a.system_key && (
                        <button onClick={() => patch(a, { active: !a.active })} className="ml-3 text-xs text-gray-500 hover:text-gray-800">
                          {a.active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Accounting() {
  const [tab, setTab] = useState('journal')
  const [accounts, setAccounts] = useState([])
  const loadAccounts = () => apiFetch('/api/accounting/accounts').then(r => r.json()).then(setAccounts)
  useEffect(() => { loadAccounts() }, [tab])

  const tabs = useMemo(() => [
    { value: 'journal', label: 'Journal' },
    { value: 'accounts', label: 'Chart of Accounts' },
  ], [])

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Accounting" subtitle="Purchases, expenses, production, sales and stock corrections are booked automatically. Reports are under Reports." />
      <div className="print:hidden"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'journal' && <Journal accounts={accounts} />}
      {tab === 'accounts' && <Accounts accounts={accounts} reload={loadAccounts} />}
    </div>
  )
}
