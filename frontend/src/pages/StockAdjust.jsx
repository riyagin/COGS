import { useState, useEffect } from 'react'

const today = () => new Date().toISOString().split('T')[0]
const num = (n, d = 2) => Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })

export default function StockAdjust() {
  const [stock, setStock] = useState([])
  const [history, setHistory] = useState([])
  const [form, setForm] = useState({ product_id: '', quantity: '', note: '', date: today() })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAll()
  }, [])

  async function fetchAll() {
    const [stockRes, histRes] = await Promise.all([
      fetch('/api/adjustments/stock').then(r => r.json()),
      fetch('/api/adjustments').then(r => r.json()),
    ])
    setStock(stockRes)
    setHistory(histRes)
    setLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    const res = await fetch('/api/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)

    const qty = parseFloat(form.quantity)
    setSuccess(
      `Adjusted ${data.product_name}: ${qty > 0 ? '+' : ''}${num(qty, 2)} ${data.unit_type}` +
      (form.note ? ` — "${form.note}"` : '')
    )
    setForm({ product_id: '', quantity: '', note: '', date: today() })
    fetchAll()
  }

  const selectedProduct = stock.find(p => p.id === Number(form.product_id))
  const qty = parseFloat(form.quantity)
  const isAdd = !isNaN(qty) && qty > 0
  const isRemove = !isNaN(qty) && qty < 0

  // Warn if removal exceeds available stock
  const stockWarning = isRemove && selectedProduct && Math.abs(qty) > selectedProduct.total_remaining
    ? `Only ${num(selectedProduct.total_remaining, 2)} ${selectedProduct.unit_type} available`
    : null

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Stock Adjustment</h2>

      <div className="grid grid-cols-3 gap-6 mb-6">
        {/* Adjustment form */}
        <div className="col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
            Manual Adjustment
          </h3>

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-md">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Product</label>
              <select
                value={form.product_id}
                onChange={e => setForm({ ...form, product_id: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              >
                <option value="">Select product</option>
                {stock.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {num(p.total_remaining, 2)} {p.unit_type} in stock
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Quantity
                <span className="ml-2 font-normal text-gray-400">(positive to add, negative to remove)</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  placeholder="e.g. 10 or -5"
                  value={form.quantity}
                  onChange={e => setForm({ ...form, quantity: e.target.value })}
                  className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent ${
                    isAdd
                      ? 'border-emerald-400 focus:ring-emerald-400'
                      : isRemove
                      ? 'border-amber-400 focus:ring-amber-400'
                      : 'border-gray-300 focus:ring-blue-500'
                  }`}
                  required
                />
                {(isAdd || isRemove) && (
                  <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold ${
                    isAdd ? 'text-emerald-600' : 'text-amber-600'
                  }`}>
                    {isAdd ? '▲ Add' : '▼ Remove'}
                    {selectedProduct ? ` · ${selectedProduct.unit_type}` : ''}
                  </span>
                )}
              </div>
              {stockWarning && (
                <p className="mt-1 text-xs text-red-500">{stockWarning}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Reason / Note
                <span className="ml-2 font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Stock count correction, damaged goods…"
                value={form.note}
                onChange={e => setForm({ ...form, note: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm({ ...form, date: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <button
              type="submit"
              disabled={!!stockWarning}
              className={`px-6 py-2 rounded-md text-sm font-semibold transition-colors ${
                stockWarning
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  : isRemove
                  ? 'bg-amber-500 text-white hover:bg-amber-600'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              Apply Adjustment
            </button>
          </form>
        </div>

        {/* Stock summary */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Current Stock</h3>
          </div>
          {loading ? (
            <div className="p-4 text-center text-gray-400 text-sm">Loading...</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
              {stock.map(p => {
                const isLow = p.total_remaining === 0
                return (
                  <li
                    key={p.id}
                    className={`px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors ${
                      form.product_id === String(p.id) ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => setForm(f => ({ ...f, product_id: String(p.id) }))}
                  >
                    <span className="text-sm text-gray-700 truncate mr-2">{p.name}</span>
                    <span className={`text-xs font-semibold shrink-0 ${isLow ? 'text-red-500' : 'text-gray-500'}`}>
                      {num(p.total_remaining, 2)} {p.unit_type}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Adjustment history */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Adjustment History</h3>
          <span className="text-xs text-gray-400">{history.length} records</span>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No adjustments yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Quantity</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.map(a => (
                <tr key={a.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 text-gray-500">{a.date}</td>
                  <td className="px-5 py-3 font-medium text-gray-800">{a.product_name}</td>
                  <td className={`px-5 py-3 text-right font-semibold ${a.quantity > 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {a.quantity > 0 ? '+' : ''}{num(a.quantity, 2)} {a.unit_type}
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
