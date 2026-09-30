import { useState, useEffect, useMemo, Fragment } from 'react'
import { apiFetch } from '../lib/api'
import { rp, rpSigned, today, monthLabel } from '../lib/format'
import { Alert, PageHeader, SectionTitle, Tabs, inputCls, labelCls, thCls, secondaryBtn, jsonOrThrow } from '../components/ui'

const TYPE_LABEL = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity',
  revenue: 'Revenue', cogs: 'Cost of goods sold', expense: 'Expenses',
}

const SOURCE_LABEL = {
  purchase: 'Purchase', purchase_payment: 'Bill payment', production: 'Production', invoice: 'Sale',
  adjustment: 'Stock adjustment', reset: 'Stock reset', opening: 'Opening balance', manual: 'Manual',
}

// ── Profit & loss ────────────────────────────────────────────────────────────

function periodRange(preset) {
  const now = new Date()
  const iso = d => d.toLocaleDateString('en-CA')
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (preset) {
    case 'last_month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))]
    case 'last_3': return [iso(new Date(y, m - 2, 1)), today()]
    case 'this_year': return [`${y}-01-01`, today()]
    default: return [iso(new Date(y, m, 1)), today()]
  }
}

function ProfitAndLoss() {
  const [preset, setPreset] = useState('this_month')
  const [range, setRange] = useState(() => periodRange('this_month'))
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    apiFetch(`/api/accounting/pnl?from=${range[0]}&to=${range[1]}`).then(jsonOrThrow).then(setReport).catch(e => setError(e.message))
  }, [range])

  function choose(p) {
    setPreset(p)
    if (p !== 'custom') setRange(periodRange(p))
  }

  const months = report && report.months.length > 1 && report.months.length <= 12 ? report.months : []
  const cols = [...months, 'total']
  const cell = (acc, col) => (col === 'total' ? acc.total : acc.by_month[col] || 0)
  const tot = (key, col) => (col === 'total' ? report.totals[key] : report.totals.by_month[col][key])

  const SectionRows = ({ type, totalKey, totalLabel }) => (
    <>
      <tr className="bg-white/30"><td colSpan={cols.length + 1} className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">{TYPE_LABEL[type]}</td></tr>
      {report.sections[type].length === 0 && (
        <tr><td colSpan={cols.length + 1} className="px-6 py-1.5 text-gray-400 text-xs">Nothing recorded</td></tr>
      )}
      {report.sections[type].map(a => (
        <tr key={a.id}>
          <td className="px-6 py-1.5 text-gray-700">{a.name}</td>
          {cols.map(c => <td key={c} className="px-4 py-1.5 text-right text-gray-600 whitespace-nowrap">{rpSigned(cell(a, c))}</td>)}
        </tr>
      ))}
      <tr className="border-t border-white/60">
        <td className="px-4 py-2 font-semibold text-gray-700">{totalLabel}</td>
        {cols.map(c => <td key={c} className="px-4 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">{rpSigned(tot(totalKey, c))}</td>)}
      </tr>
    </>
  )

  const ProfitRow = ({ label, k, strong }) => (
    <tr className={strong ? 'bg-indigo-50/70' : 'bg-white/20'}>
      <td className={`px-4 py-2.5 ${strong ? 'font-bold text-gray-900' : 'font-semibold text-gray-800'}`}>{label}</td>
      {cols.map(c => {
        const v = tot(k, c)
        const rev = tot('revenue', c)
        return (
          <td key={c} className={`px-4 py-2.5 text-right whitespace-nowrap ${strong ? 'font-bold' : 'font-semibold'} ${v < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
            {rpSigned(v)}
            {rev > 0 && <span className="block text-[11px] font-normal text-gray-400">{((v / rev) * 100).toFixed(1)}% of revenue</span>}
          </td>
        )
      })}
    </tr>
  )

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-4 print:hidden">
        <div>
          <label className={labelCls}>Period</label>
          <select value={preset} onChange={e => choose(e.target.value)} className={inputCls}>
            <option value="this_month">This month</option>
            <option value="last_month">Last month</option>
            <option value="last_3">Last 3 months</option>
            <option value="this_year">This year</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div><label className={labelCls}>From</label><input type="date" value={range[0]} onChange={e => setRange([e.target.value, range[1]])} className={inputCls} /></div>
            <div><label className={labelCls}>To</label><input type="date" value={range[1]} onChange={e => setRange([range[0], e.target.value])} className={inputCls} /></div>
          </>
        )}
        <button onClick={() => window.print()} className={`${secondaryBtn} ml-auto`}>Print</button>
      </div>
      <Alert onClose={() => setError('')}>{error}</Alert>

      {report && (
        <div className="glass-card overflow-hidden">
          <div className="px-4 py-3 border-b border-white/50">
            <p className="font-semibold text-gray-800">Profit & Loss</p>
            <p className="text-xs text-gray-500">{report.from} to {report.to}</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/60">
                <th className={`${thCls} text-left`}></th>
                {cols.map(c => <th key={c} className={`${thCls} text-right`}>{c === 'total' ? 'Total' : monthLabel(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              <SectionRows type="revenue" totalKey="revenue" totalLabel="Total revenue" />
              <SectionRows type="cogs" totalKey="cogs" totalLabel="Total cost of goods sold" />
              <ProfitRow label="Gross profit" k="gross_profit" />
              <SectionRows type="expense" totalKey="expense" totalLabel="Total expenses" />
              <ProfitRow label="Net profit" k="net_profit" strong />
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-gray-400 border-t border-white/50">
            Cost of goods sold is the FIFO cost of what was sold, plus stock written off or found in adjustments and counts.
            Purchases of stock are not costs until the stock is used and sold.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Balance sheet ────────────────────────────────────────────────────────────

function BalanceSheet() {
  const [date, setDate] = useState(today())
  const [report, setReport] = useState(null)
  useEffect(() => { apiFetch(`/api/accounting/balance-sheet?date=${date}`).then(r => r.json()).then(setReport) }, [date])

  const Section = ({ type, total }) => (
    <>
      <tr className="bg-white/30"><td colSpan={2} className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">{TYPE_LABEL[type]}</td></tr>
      {report.sections[type].map(a => (
        <tr key={a.id ?? a.name}>
          <td className="px-6 py-1.5 text-gray-700">{a.name}</td>
          <td className="px-4 py-1.5 text-right text-gray-600">{rpSigned(a.balance)}</td>
        </tr>
      ))}
      <tr className="border-t border-white/60">
        <td className="px-4 py-2 font-semibold text-gray-700">Total {TYPE_LABEL[type].toLowerCase()}</td>
        <td className="px-4 py-2 text-right font-semibold text-gray-800">{rpSigned(total)}</td>
      </tr>
    </>
  )

  return (
    <div>
      <div className="flex items-end gap-3 mb-4">
        <div><label className={labelCls}>As of</label><input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} /></div>
      </div>
      {report && (
        <div className="glass-card overflow-hidden max-w-2xl">
          <table className="w-full text-sm">
            <tbody>
              <Section type="asset" total={report.totals.assets} />
              <Section type="liability" total={report.totals.liabilities} />
              <Section type="equity" total={report.totals.equity} />
              <tr className="bg-indigo-50/70">
                <td className="px-4 py-2.5 font-bold text-gray-900">Liabilities + equity</td>
                <td className="px-4 py-2.5 text-right font-bold text-gray-900">{rpSigned(report.totals.liabilities_and_equity)}</td>
              </tr>
            </tbody>
          </table>
          <p className={`px-4 py-3 text-xs border-t border-white/50 ${report.totals.balanced ? 'text-emerald-600' : 'text-red-600'}`}>
            {report.totals.balanced ? '✓ Assets equal liabilities + equity' : 'Books do not balance. Check the journal.'}
            {report.sections.asset.some(a => a.name === 'Cash' && a.balance < 0) && (
              <span className="block text-amber-700 mt-1">Cash is negative: record the money you started with as “Owner puts in capital” in the Journal tab.</span>
            )}
          </p>
        </div>
      )}
    </div>
  )
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
            <input type="number" step="any" min="0" value={amount} onChange={e => setAmount(e.target.value)} className={inputCls} required />
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
              <input type="number" step="any" min="0" placeholder="Debit" value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: '' })} className={inputCls} />
              <input type="number" step="any" min="0" placeholder="Credit" value={l.credit} onChange={e => setLine(i, { credit: e.target.value, debit: '' })} className={inputCls} />
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
  const [form, setForm] = useState({ code: '', name: '', type: 'expense' })
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)

  async function add(e) {
    e.preventDefault()
    setError('')
    try {
      await jsonOrThrow(await apiFetch('/api/accounting/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }))
      setForm({ code: '', name: '', type: form.type })
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
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[6rem_1fr_12rem_auto] gap-3 items-end">
          <div><label className={labelCls}>Code</label><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} className={inputCls} placeholder="6600" required /></div>
          <div><label className={labelCls}>Name</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Marketing" required /></div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className={inputCls}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary px-5 py-2">Add</button>
        </form>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/30 border-b border-white/60">
              <th className={`${thCls} text-left w-20`}>Code</th>
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
                    <td className="px-4 py-2 text-gray-500">{a.code}</td>
                    <td className="px-4 py-2 text-gray-800">
                      {editing?.id === a.id ? (
                        <input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') patch(a, { name: editing.name }); if (e.key === 'Escape') setEditing(null) }}
                          className="glass-input px-2 py-1 text-sm w-full" />
                      ) : a.name}
                      {a.system_key && <span className="ml-2 text-[11px] text-gray-400" title="Posted to automatically by the app">auto</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700 whitespace-nowrap">{rpSigned(a.balance)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {editing?.id === a.id ? (
                        <button onClick={() => patch(a, { name: editing.name })} className="text-xs text-indigo-600 font-medium">Save</button>
                      ) : (
                        <button onClick={() => setEditing({ id: a.id, name: a.name })} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">Rename</button>
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
  const [tab, setTab] = useState('pnl')
  const [accounts, setAccounts] = useState([])
  const loadAccounts = () => apiFetch('/api/accounting/accounts').then(r => r.json()).then(setAccounts)
  useEffect(() => { loadAccounts() }, [tab])

  const tabs = useMemo(() => [
    { value: 'pnl', label: 'Profit & Loss' },
    { value: 'balance', label: 'Balance Sheet' },
    { value: 'journal', label: 'Journal' },
    { value: 'accounts', label: 'Accounts' },
  ], [])

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Accounting" subtitle="Purchases, production, sales and stock corrections are booked automatically" />
      <div className="print:hidden"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'pnl' && <ProfitAndLoss />}
      {tab === 'balance' && <BalanceSheet />}
      {tab === 'journal' && <Journal accounts={accounts} />}
      {tab === 'accounts' && <Accounts accounts={accounts} reload={loadAccounts} />}
    </div>
  )
}
