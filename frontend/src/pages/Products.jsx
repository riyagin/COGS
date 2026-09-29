import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

const UNIT_TYPES = ['kg', 'g', 'L', 'mL', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'piece', 'dozen', 'unit', 'box', 'bag', 'bottle']

export default function Products() {
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ name: '', unit_type: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/products')
      .then(r => r.json())
      .then(data => { setProducts(data); setLoading(false) })
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const res = await apiFetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setProducts(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
    setForm({ name: '', unit_type: '' })
  }

  async function handleDelete(id) {
    if (!confirm('Delete this product? This cannot be undone.')) return
    const res = await apiFetch(`/api/products/${id}`, { method: 'DELETE' })
    if (res.ok) setProducts(prev => prev.filter(p => p.id !== id))
    else {
      const data = await res.json()
      alert(data.error || 'Failed to delete')
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4 sm:mb-6">Products</h2>

      <div className="glass-card p-4 sm:p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Register Product</h3>
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Product name"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="flex-1 glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
            required
          />
          <select
            value={form.unit_type}
            onChange={e => setForm({ ...form, unit_type: e.target.value })}
            className="w-36 glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60"
            required
          >
            <option value="">Unit type</option>
            {UNIT_TYPES.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <button
            type="submit"
            className="btn-primary px-5 py-2"
          >
            Add
          </button>
        </form>
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : products.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No products registered yet.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit</th>
                <th className="px-5 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {products.map(p => (
                <tr key={p.id} className="hover:bg-white/40 transition-colors">
                  <td className="px-5 py-3 text-sm font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-sm text-gray-500">{p.unit_type}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
