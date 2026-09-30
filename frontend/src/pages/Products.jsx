import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { rp, qty } from '../lib/format'
import { Alert, ItemSelect, PageHeader, SectionTitle, inputCls, labelCls, secondaryBtn, jsonOrThrow } from '../components/ui'

const emptyForm = () => ({ name: '', unit: 'pcs', sell_price: '', active: true, components: [{ item_id: '', quantity: '1' }] })

function ProductForm({ items, product, onSaved, onCancel }) {
  const [form, setForm] = useState(() => product ? {
    name: product.name,
    unit: product.unit,
    sell_price: product.sell_price ?? '',
    active: product.active,
    components: product.components.map(c => ({ item_id: String(c.item_id), quantity: String(c.quantity) })),
  } : emptyForm())
  const [error, setError] = useState('')

  const setComp = (idx, field, value) => setForm(f => ({
    ...f, components: f.components.map((c, i) => i === idx ? { ...c, [field]: value } : c),
  }))

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    try {
      const saved = await jsonOrThrow(await apiFetch(product ? `/api/products/${product.id}` : '/api/products', {
        method: product ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }))
      onSaved(saved)
    } catch (err) { setError(err.message) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_10rem] gap-3">
        <div>
          <label className={labelCls}>Product name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls}
            placeholder="e.g. Risoles SMB box isi 10" required />
        </div>
        <div>
          <label className={labelCls}>Sold per</label>
          <input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} className={inputCls} placeholder="pcs, box" />
        </div>
        <div>
          <label className={labelCls}>Selling price (Rp)</label>
          <input type="number" step="any" min="0" value={form.sell_price} onChange={e => setForm({ ...form, sell_price: e.target.value })} className={inputCls} />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">Made of (per {form.unit || 'unit'} sold)</span>
          <button type="button" onClick={() => setForm(f => ({ ...f, components: [...f.components, { item_id: '', quantity: '1' }] }))}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">+ Add item</button>
        </div>
        <div className="space-y-2">
          {form.components.map((c, idx) => {
            const item = items.find(i => i.id === Number(c.item_id))
            return (
              <div key={idx} className="flex gap-2 items-center">
                <div className="flex-1 min-w-0">
                  <ItemSelect items={items} value={c.item_id} onChange={v => setComp(idx, 'item_id', v)} tiers={['final', 'raw', 'preprocessed']} />
                </div>
                <input type="number" step="any" min="0" value={c.quantity} onChange={e => setComp(idx, 'quantity', e.target.value)}
                  className="w-24 glass-input px-2 py-2 text-sm" required />
                <span className="w-12 text-xs text-gray-500">{item?.unit_type}</span>
                {form.components.length > 1 && (
                  <button type="button" onClick={() => setForm(f => ({ ...f, components: f.components.filter((_, i) => i !== idx) }))}
                    className="text-gray-400 hover:text-red-500 text-lg leading-none">×</button>
                )}
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-gray-500">Selling one {form.unit || 'unit'} takes these items out of stock. Add packaging (boxes, bags) as raw items to count it too.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary px-5 py-2">{product ? 'Save Product' : 'Create Product'}</button>
        <button type="button" onClick={onCancel} className={secondaryBtn}>Cancel</button>
        {product && (
          <label className="flex items-center gap-2 text-sm text-gray-600 ml-auto">
            <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />
            Active (offered for sale)
          </label>
        )}
      </div>
    </form>
  )
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [items, setItems] = useState([])
  const [editing, setEditing] = useState(null) // null | 'new' | product
  const [loading, setLoading] = useState(true)

  const load = () => apiFetch('/api/products').then(r => r.json()).then(data => { setProducts(data); setLoading(false) })
  useEffect(() => {
    load()
    apiFetch('/api/items').then(r => r.json()).then(setItems)
  }, [])

  async function handleDelete(p) {
    if (!confirm(`Delete "${p.name}"?`)) return
    try {
      await jsonOrThrow(await apiFetch(`/api/products/${p.id}`, { method: 'DELETE' }))
      setProducts(prev => prev.filter(x => x.id !== p.id))
    } catch (err) { alert(err.message) }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="Products" subtitle="What you sell, and which items leave stock when you do">
        {!editing && <button onClick={() => setEditing('new')} className="btn-primary px-4 py-2">+ New Product</button>}
      </PageHeader>

      {editing && (
        <div className="glass-card ring-1 ring-indigo-300/60 p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4 !text-indigo-600">{editing === 'new' ? 'New Product' : `Editing: ${editing.name}`}</SectionTitle>
          <ProductForm
            key={editing === 'new' ? 'new' : editing.id}
            items={items}
            product={editing === 'new' ? null : editing}
            onSaved={() => { setEditing(null); load() }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {loading ? (
        <div className="glass-card p-8 text-center text-gray-400 text-sm">Loading...</div>
      ) : products.length === 0 ? (
        <div className="glass-card p-8 text-center text-gray-400 text-sm">No products yet.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {products.map(p => {
            const margin = p.sell_price > 0 ? (p.sell_price - p.est_cost) / p.sell_price : null
            return (
              <div key={p.id} className={`glass-card p-4 ${p.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{p.name}</p>
                    <p className="text-xs text-gray-500">per {p.unit}{!p.active && ' · inactive'}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-gray-800">{p.sell_price != null ? rp(p.sell_price) : <span className="text-gray-400 font-normal text-sm">no price</span>}</p>
                    <p className="text-xs text-gray-500">cost ≈ {rp(p.est_cost)}{p.price_missing && ' *'}</p>
                  </div>
                </div>
                <ul className="mt-3 text-sm text-gray-600 space-y-0.5">
                  {p.components.map(c => (
                    <li key={c.id} className="flex justify-between gap-2">
                      <span className="truncate">{qty(c.quantity)} {c.unit_type} {c.item_name}</span>
                      <span className="text-gray-400 shrink-0">{rp(c.cost)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 pt-3 border-t border-white/50 flex items-center justify-between">
                  {margin != null ? (
                    <span className={`text-xs font-semibold ${margin >= 0.5 ? 'text-emerald-600' : margin >= 0.25 ? 'text-amber-600' : 'text-red-500'}`}>
                      Margin {(margin * 100).toFixed(0)}% · {rp(p.sell_price - p.est_cost)} per {p.unit}
                    </span>
                  ) : <span />}
                  <div className="flex gap-3">
                    <button onClick={() => setEditing(p)} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">Edit</button>
                    <button onClick={() => handleDelete(p)} className="text-xs text-red-400 hover:text-red-600 font-medium">Delete</button>
                  </div>
                </div>
                {p.price_missing && <p className="mt-2 text-[11px] text-gray-400">* some ingredients have no purchase price yet</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
