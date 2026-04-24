import { useState, useEffect, useMemo } from 'react'

const today = () => new Date().toISOString().split('T')[0]

const rp = n => 'Rp ' + Number(n).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const num = (n, d = 4) => Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })

const PAGE_SIZE = 20

export default function Inventory() {
  const [items, setItems] = useState([])
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ product_id: '', amount: '', price: '', date_of_purchase: today() })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    Promise.all([fetch('/api/inventory').then(r => r.json()), fetch('/api/products').then(r => r.json())])
      .then(([inv, prod]) => { setItems(inv); setProducts(prod); setLoading(false) })
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setItems(prev => [data, ...prev])
    setForm({ product_id: '', amount: '', price: '', date_of_purchase: today() })
    setPage(1)
  }

  async function handleDelete(id) {
    if (!confirm('Delete this inventory item?')) return
    const res = await fetch(`/api/inventory/${id}`, { method: 'DELETE' })
    if (res.ok) setItems(prev => prev.filter(i => i.id !== id))
  }

  const unitPrice = form.amount && form.price && Number(form.amount) > 0
    ? Number(form.price) / Number(form.amount)
    : null

  const selectedProduct = products.find(p => p.id === Number(form.product_id))

  // Filter by search, then paginate
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(i => i.product_name.toLowerCase().includes(q))
  }, [items, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // Reset to page 1 when search changes
  useEffect(() => { setPage(1) }, [search])

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Inventory</h2>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Record Purchase</h3>
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Product</label>
            <select
              value={form.product_id}
              onChange={e => setForm({ ...form, product_id: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            >
              <option value="">Select product</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit_type})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Amount{selectedProduct ? ` (${selectedProduct.unit_type})` : ''}
            </label>
            <input
              type="number"
              step="any"
              min="0"
              placeholder="0.00"
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Total Price (Rp)</label>
            <div className="relative">
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0"
                value={form.price}
                onChange={e => setForm({ ...form, price: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              {unitPrice && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                  Rp {Number(unitPrice).toLocaleString('id-ID')}/{selectedProduct?.unit_type}
                </span>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date of Purchase</label>
            <input
              type="date"
              value={form.date_of_purchase}
              onChange={e => setForm({ ...form, date_of_purchase: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>
          <div className="col-span-2">
            <button
              type="submit"
              className="bg-blue-600 text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Add to Inventory
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Header with search */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider shrink-0">
            Inventory Entries
          </h3>
          <div className="flex-1 max-w-xs relative">
            <input
              type="text"
              placeholder="Search by product name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded-md pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
          </div>
          <span className="text-xs text-gray-400 ml-auto shrink-0">
            {filtered.length} {filtered.length !== items.length ? `of ${items.length} ` : ''}entries
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            {search ? `No entries matching "${search}".` : 'No inventory items yet.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Remaining</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Price</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit Price</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                    <th className="px-4 py-3 w-14"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pageItems.map(item => {
                    const pctLeft = item.amount > 0 ? item.remaining / item.amount : 0
                    const stockColor = item.remaining <= 0
                      ? 'text-red-500'
                      : pctLeft < 0.2
                      ? 'text-amber-600'
                      : 'text-emerald-600'

                    return (
                      <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-sm font-medium text-gray-800">{item.product_name}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">{item.date_of_purchase}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 text-right">
                          {num(item.amount)} {item.unit_type}
                        </td>
                        <td className={`px-4 py-3 text-sm text-right font-medium ${stockColor}`}>
                          {num(item.remaining)} {item.unit_type}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 text-right">
                          {rp(item.price)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 text-right">
                          {rp(item.unit_price)}/{item.unit_type}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            item.source === 'production'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-emerald-100 text-emerald-700'
                          }`}>
                            {item.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-400">
                  Page {safePage} of {totalPages} · showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(1)}
                    disabled={safePage === 1}
                    className="px-2 py-1 text-xs rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    «
                  </button>
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="px-2 py-1 text-xs rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ‹
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(n => n === 1 || n === totalPages || Math.abs(n - safePage) <= 1)
                    .reduce((acc, n, idx, arr) => {
                      if (idx > 0 && n - arr[idx - 1] > 1) acc.push('…')
                      acc.push(n)
                      return acc
                    }, [])
                    .map((n, i) =>
                      n === '…'
                        ? <span key={`ellipsis-${i}`} className="px-1 text-xs text-gray-400">…</span>
                        : <button
                            key={n}
                            onClick={() => setPage(n)}
                            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                              n === safePage
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-500 hover:bg-gray-100'
                            }`}
                          >
                            {n}
                          </button>
                    )
                  }
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="px-2 py-1 text-xs rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ›
                  </button>
                  <button
                    onClick={() => setPage(totalPages)}
                    disabled={safePage === totalPages}
                    className="px-2 py-1 text-xs rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
