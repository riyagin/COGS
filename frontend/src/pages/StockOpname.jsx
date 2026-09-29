import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

const today = () => new Date().toISOString().split('T')[0]
const num = (n, d = 2) => Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })

export default function StockOpname() {
  const [stock, setStock] = useState([])
  const [history, setHistory] = useState([])
  const [form, setForm] = useState({ product_id: '', counted_quantity: '', note: '', date: today() })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAll()
  }, [])

  async function fetchAll() {
    const [stockRes, histRes] = await Promise.all([
      apiFetch('/api/adjustments/stock').then(r => r.json()),
      apiFetch('/api/adjustments').then(r => r.json()),
    ])
    setStock(stockRes)
    setHistory(histRes.filter(h => h.type === 'opname'))
    setLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSubmitting(true)

    try {
      const res = await apiFetch('/api/adjustments/opname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) return setError(data.error)

      if (data.delta === 0) {
        setSuccess(`${data.product_name}: no change — already at ${num(data.counted_quantity)} ${data.unit_type}`)
      } else {
        setSuccess(
          `${data.product_name}: counted ${num(data.counted_quantity)} ${data.unit_type} ` +
          `(was ${num(data.previous_quantity)}, ${data.delta > 0 ? '+' : ''}${num(data.delta)})`
        )
      }
      setForm({ product_id: '', counted_quantity: '', note: '', date: today() })
      fetchAll()
    } catch {
      setError('Failed to record stock opname')
    } finally {
      setSubmitting(false)
    }
  }

  const selectedProduct = stock.find(p => p.id === Number(form.product_id))
  const counted = parseFloat(form.counted_quantity)
  const hasDelta = selectedProduct && !isNaN(counted)
  const delta = hasDelta ? counted - selectedProduct.total_remaining : null

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Stock Opname</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Record a physical stock count — the system overwrites tracked stock to match what you counted.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {/* Opname form */}
        <div className="md:col-span-2 glass-card p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
            Record Physical Count
          </h3>

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 text-sm text-emerald-700 bg-emerald-50/70 border border-emerald-200/70 px-3 py-2 rounded-lg">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Product</label>
              <select
                value={form.product_id}
                onChange={e => setForm({ ...form, product_id: e.target.value })}
                className="w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
                required
              >
                <option value="">Select product</option>
                {stock.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — system says {num(p.total_remaining)} {p.unit_type}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Counted Quantity
                <span className="ml-2 font-normal text-gray-400">(the actual amount on hand)</span>
              </label>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="e.g. 25"
                value={form.counted_quantity}
                onChange={e => setForm({ ...form, counted_quantity: e.target.value })}
                className="w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
                required
              />
              {hasDelta && (
                <p className={`mt-1 text-xs font-medium ${
                  delta === 0 ? 'text-gray-400' : delta > 0 ? 'text-emerald-600' : 'text-amber-600'
                }`}>
                  {delta === 0
                    ? 'No change from current system stock'
                    : `Will ${delta > 0 ? 'add' : 'remove'} ${num(Math.abs(delta))} ${selectedProduct.unit_type} ${delta > 0 ? '(at historical avg. price)' : '(FIFO)'}`}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Note
                <span className="ml-2 font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Monthly physical count"
                value={form.note}
                onChange={e => setForm({ ...form, note: e.target.value })}
                className="w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Count Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm({ ...form, date: e.target.value })}
                className="w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary px-6 py-2 font-semibold"
            >
              {submitting ? 'Recording...' : 'Record Count'}
            </button>
          </form>
        </div>

        {/* Stock summary */}
        <div className="glass-card overflow-hidden">
          <div className="px-4 py-3 border-b border-white/50">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">System Stock</h3>
          </div>
          {loading ? (
            <div className="p-4 text-center text-gray-400 text-sm">Loading...</div>
          ) : (
            <ul className="divide-y divide-white/50 max-h-96 overflow-y-auto">
              {stock.map(p => (
                <li
                  key={p.id}
                  className={`px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-white/40 transition-colors ${
                    form.product_id === String(p.id) ? 'bg-indigo-50/60' : ''
                  }`}
                  onClick={() => setForm(f => ({ ...f, product_id: String(p.id) }))}
                >
                  <span className="text-sm text-gray-700 truncate mr-2">{p.name}</span>
                  <span className="text-xs font-semibold shrink-0 text-gray-500">
                    {num(p.total_remaining)} {p.unit_type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Opname history */}
      <div className="glass-card overflow-hidden">
        <div className="px-4 sm:px-6 py-4 border-b border-white/50 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Opname History</h3>
          <span className="text-xs text-gray-400">{history.length} records</span>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No stock counts recorded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Adjustment</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {history.map(a => (
                <tr key={a.id} className="hover:bg-white/40 transition-colors">
                  <td className="px-5 py-3 text-gray-500">{a.date}</td>
                  <td className="px-5 py-3 font-medium text-gray-800">{a.product_name}</td>
                  <td className={`px-5 py-3 text-right font-semibold ${a.quantity > 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {a.quantity > 0 ? '+' : ''}{num(a.quantity)} {a.unit_type}
                  </td>
                  <td className="px-5 py-3 text-gray-500 italic">{a.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
