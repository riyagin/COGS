import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { rp, today } from '../lib/format'
import { Alert, MoneyInput, PageHeader, Segmented, SectionTitle, inputCls, labelCls, thCls, secondaryBtn, jsonOrThrow } from '../components/ui'
import PeriodPicker, { defaultPeriod, rangeOf } from '../components/PeriodPicker'

const PAYMENT_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'unpaid', label: 'Unpaid' },
]

const NEW_CATEGORY = 'new'

const emptyForm = (date = today(), payment = 'cash') =>
  ({ date, account_id: '', amount: '', payment, payee: '', description: '', reference: '' })

const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// How an expense was paid, as the form's payment choice
const paymentOf = x => (!x.paid_date ? 'unpaid' : x.paid_from_key === 'bank' ? 'bank' : 'cash')

function ExpenseForm({ editing, categories, payees, onSaved, onCancel, onCategoryAdded }) {
  const [form, setForm] = useState(() => editing
    ? { ...emptyForm(), ...editing, account_id: String(editing.account_id), amount: String(editing.amount), payment: paymentOf(editing),
        payee: editing.payee || '', description: editing.description || '', reference: editing.reference || '' }
    : emptyForm())
  const [newCategory, setNewCategory] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = patch => setForm(f => ({ ...f, ...patch }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      let accountId = form.account_id
      if (accountId === NEW_CATEGORY) {
        const account = await jsonOrThrow(await apiFetch('/api/accounting/accounts', {
          method: 'POST', ...json({ name: newCategory.trim(), type: 'expense' }),
        }))
        onCategoryAdded(account)
        accountId = String(account.id)
        set({ account_id: accountId })
        setNewCategory('')
      }
      const body = { ...form, account_id: Number(accountId), amount: Number(form.amount) }
      const saved = await jsonOrThrow(await apiFetch(editing ? `/api/expenses/${editing.id}` : '/api/expenses', {
        method: editing ? 'PUT' : 'POST', ...json(body),
      }))
      if (!editing) setForm(f => emptyForm(f.date, f.payment))
      onSaved(saved)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr_11rem] gap-3">
        <div>
          <label className={labelCls}>Date</label>
          <input type="date" value={form.date} onChange={e => set({ date: e.target.value })} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Category</label>
          <select value={form.account_id} onChange={e => set({ account_id: e.target.value })} className={inputCls} required>
            <option value="">Choose…</option>
            {categories.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            <option value={NEW_CATEGORY}>+ New category…</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Amount (Rp)</label>
          <MoneyInput value={form.amount} onChange={amount => set({ amount })} placeholder="0" required />
        </div>
      </div>

      {form.account_id === NEW_CATEGORY && (
        <div>
          <label className={labelCls}>New category name</label>
          <input value={newCategory} onChange={e => setNewCategory(e.target.value)} className={inputCls}
            placeholder="e.g. Marketing, Internet, Cleaning" required autoFocus />
          <p className="mt-1 text-xs text-gray-500">It becomes an expense account with the next free 6-digit number (6xxxxx).</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_11rem] gap-3">
        <div>
          <label className={labelCls}>Paid to</label>
          <input list="payee-list" value={form.payee} onChange={e => set({ payee: e.target.value })} className={inputCls} placeholder="e.g. PLN, landlord, staff name" />
          <datalist id="payee-list">{payees.map(p => <option key={p} value={p} />)}</datalist>
        </div>
        <div>
          <label className={labelCls}>What for</label>
          <input value={form.description} onChange={e => set({ description: e.target.value })} className={inputCls} placeholder="e.g. Electricity September" />
        </div>
        <div>
          <label className={labelCls}>Receipt / ref no.</label>
          <input value={form.reference} onChange={e => set({ reference: e.target.value })} className={inputCls} placeholder="optional" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <span className={labelCls}>Paid from</span>
          <Segmented options={PAYMENT_OPTIONS} value={form.payment} onChange={payment => set({ payment })} />
        </div>
        {form.payment === 'unpaid' && <p className="text-xs text-gray-500 mt-4">Owed until you mark it paid below.</p>}
        <div className="flex gap-3 ml-auto mt-4">
          {onCancel && <button type="button" onClick={onCancel} className={secondaryBtn}>Cancel</button>}
          <button type="submit" disabled={saving} className="btn-primary px-5 py-2 disabled:opacity-60">
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add expense'}
          </button>
        </div>
      </div>
    </form>
  )
}

function PayButton({ expense, onPaid }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(today())
  const [payment, setPayment] = useState('cash')
  if (!open) return <button onClick={() => setOpen(true)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Mark paid</button>

  async function pay() {
    try {
      onPaid(await jsonOrThrow(await apiFetch(`/api/expenses/${expense.id}/pay`, { method: 'POST', ...json({ date, payment }) })))
    } catch (err) { alert(err.message) }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 justify-end">
      <input type="date" value={date} min={expense.date} onChange={e => setDate(e.target.value)} className="glass-input px-2 py-1 text-xs" />
      <select value={payment} onChange={e => setPayment(e.target.value)} className="glass-input px-2 py-1 text-xs">
        <option value="cash">Cash</option>
        <option value="bank">Bank</option>
      </select>
      <button onClick={pay} className="text-xs font-semibold text-indigo-600">Pay</button>
      <button onClick={() => setOpen(false)} className="text-xs text-gray-400">×</button>
    </span>
  )
}

export default function Expenses() {
  const [categories, setCategories] = useState([])
  const [payees, setPayees] = useState([])
  const [period, setPeriod] = useState(() => defaultPeriod('month'))
  const [filter, setFilter] = useState({ account_id: '', unpaid: false })
  const [expenses, setExpenses] = useState([])
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [from, to] = rangeOf(period)

  const loadCategories = () => apiFetch('/api/accounting/accounts').then(jsonOrThrow)
    .then(all => setCategories(all.filter(a => a.active && ['expense', 'cogs'].includes(a.type))))
    .catch(e => setError(e.message))

  const load = () => {
    const params = new URLSearchParams({ from, to })
    if (filter.account_id) params.set('account_id', filter.account_id)
    if (filter.unpaid) { params.set('status', 'unpaid'); params.delete('from'); params.delete('to') }
    apiFetch(`/api/expenses?${params}`).then(jsonOrThrow).then(setExpenses).catch(e => setError(e.message))
    apiFetch('/api/expenses/payees').then(jsonOrThrow).then(setPayees).catch(() => {})
  }

  useEffect(() => { loadCategories() }, [])
  useEffect(load, [from, to, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(x) {
    if (!confirm(`Delete this expense of ${rp(x.amount)}?`)) return
    try {
      await jsonOrThrow(await apiFetch(`/api/expenses/${x.id}`, { method: 'DELETE' }))
      load()
    } catch (err) { setError(err.message) }
  }

  const total = expenses.reduce((s, x) => s + x.amount, 0)
  const unpaid = expenses.filter(x => !x.paid_date).reduce((s, x) => s + x.amount, 0)
  const onCategoryAdded = a => setCategories(cs => [...cs, a].sort((p, q) => p.code.localeCompare(q.code)))

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Expenses" subtitle="Rent, wages, electricity and other spending that isn't stock" />

      {editing ? (
        <div className="glass-card ring-1 ring-indigo-300/60 p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4 !text-indigo-600">Edit Expense</SectionTitle>
          <ExpenseForm key={editing.id} editing={editing} categories={categories} payees={payees}
            onSaved={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} onCategoryAdded={onCategoryAdded} />
        </div>
      ) : (
        <div className="glass-card p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4">New Expense</SectionTitle>
          <ExpenseForm key="new" categories={categories} payees={payees} onSaved={load} onCategoryAdded={onCategoryAdded} />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-3">
        {!filter.unpaid && <PeriodPicker value={period} onChange={setPeriod} />}
        <div>
          <label className={labelCls}>Category</label>
          <select value={filter.account_id} onChange={e => setFilter({ ...filter, account_id: e.target.value })} className={inputCls}>
            <option value="">All</option>
            {categories.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 pb-2">
          <input type="checkbox" checked={filter.unpaid} onChange={e => setFilter({ ...filter, unpaid: e.target.checked })} />
          Unpaid only (any date)
        </label>
      </div>
      <Alert onClose={() => setError('')}>{error}</Alert>

      <div className="glass-card overflow-hidden">
        {expenses.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No expenses here.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/30 border-b border-white/60">
                  <th className={`${thCls} text-left`}>Date</th>
                  <th className={`${thCls} text-left`}>Category</th>
                  <th className={`${thCls} text-left`}>Details</th>
                  <th className={`${thCls} text-right`}>Amount</th>
                  <th className={`${thCls} text-right`}>Paid</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(x => (
                  <tr key={x.id} className="border-t border-white/40 align-top">
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{x.date}</td>
                    <td className="px-4 py-2 text-gray-700 whitespace-nowrap"><span className="text-gray-400 tabular-nums mr-1.5">{x.account_code}</span>{x.account_name}</td>
                    <td className="px-4 py-2 text-gray-700">
                      {x.description || <span className="text-gray-400">—</span>}
                      {(x.payee || x.reference) && <span className="block text-xs text-gray-400">{[x.payee, x.reference].filter(Boolean).join(' · ')}</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-gray-800 whitespace-nowrap">{rp(x.amount)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {x.paid_date
                        ? <span className="text-xs text-gray-500">{x.paid_from_name}{x.paid_date !== x.date && ` · ${x.paid_date}`}</span>
                        : <span className="flex flex-col items-end gap-1"><span className="text-xs font-semibold text-amber-600">Unpaid</span><PayButton expense={x} onPaid={load} /></span>}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button onClick={() => { setEditing(x); document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' }) }} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">Edit</button>
                      <button onClick={() => remove(x)} className="ml-3 text-xs text-red-400 hover:text-red-600">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/70 bg-indigo-50/60">
                  <td colSpan={3} className="px-4 py-2.5 font-semibold text-gray-800">
                    Total · {expenses.length} expense{expenses.length === 1 ? '' : 's'}
                    {unpaid > 0 && <span className="ml-2 text-xs font-medium text-amber-600">{rp(unpaid)} unpaid</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-bold text-gray-900 whitespace-nowrap">{rp(total)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
