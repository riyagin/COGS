import { useState, useEffect, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import { qty, rp, unitRp, TIERS, TIER_LABEL, TIER_HINT } from '../lib/format'
import { Alert, TierBadge, PageHeader, SectionTitle, Tabs, inputCls, labelCls, thCls, jsonOrThrow } from '../components/ui'

const UNIT_TYPES = ['g', 'kg', 'mL', 'L', 'piece', 'pack', 'box', 'bag', 'bottle', 'can', 'sheet', 'dozen', 'tbsp', 'tsp', 'cup']

function EditRow({ item, onSaved, onCancel }) {
  const [form, setForm] = useState({ name: item.name, unit_type: item.unit_type, tier: item.tier })
  const [error, setError] = useState('')

  async function save() {
    setError('')
    try {
      const data = await jsonOrThrow(await apiFetch(`/api/items/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }))
      onSaved({ ...item, ...data })
    } catch (err) { setError(err.message) }
  }

  const units = UNIT_TYPES.includes(form.unit_type) ? UNIT_TYPES : [form.unit_type, ...UNIT_TYPES]
  return (
    <tr className="bg-indigo-50/50">
      <td colSpan={7} className="px-4 py-3">
        {error && <Alert onClose={() => setError('')}>{error}</Alert>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[12rem]">
            <label className={labelCls}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} />
          </div>
          <div className="w-32">
            <label className={labelCls}>Unit</label>
            <select value={form.unit_type} onChange={e => setForm({ ...form, unit_type: e.target.value })} className={inputCls}>
              {units.map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
          <div className="w-44">
            <label className={labelCls}>Tier</label>
            <select value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })} className={inputCls}>
              {TIERS.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
            </select>
          </div>
          <button onClick={save} className="btn-primary px-4 py-2">Save</button>
          <button onClick={onCancel} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-800">Cancel</button>
        </div>
      </td>
    </tr>
  )
}

export default function Items() {
  const [items, setItems] = useState([])
  const [form, setForm] = useState({ name: '', unit_type: '', tier: 'raw' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState(null)

  const load = () => apiFetch('/api/items').then(r => r.json()).then(data => { setItems(data); setLoading(false) })
  useEffect(() => { load() }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    try {
      await jsonOrThrow(await apiFetch('/api/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      }))
      setForm(f => ({ name: '', unit_type: '', tier: f.tier }))
      load()
    } catch (err) { setError(err.message) }
  }

  async function handleDelete(item) {
    if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    try {
      await jsonOrThrow(await apiFetch(`/api/items/${item.id}`, { method: 'DELETE' }))
      setItems(prev => prev.filter(i => i.id !== item.id))
    } catch (err) { alert(err.message) }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(i => (tab === 'all' || i.tier === tab) && (!q || i.name.toLowerCase().includes(q)))
  }, [items, tab, search])

  const counts = Object.fromEntries(TIERS.map(t => [t, items.filter(i => i.tier === t).length]))

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Items" subtitle="Everything you keep in stock, from raw materials to finished goods" />

      <div className="glass-card p-4 sm:p-6 mb-6">
        <SectionTitle className="mb-4">Register Item</SectionTitle>
        <Alert onClose={() => setError('')}>{error}</Alert>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-[1fr_8rem_12rem_auto] gap-3 items-end">
          <div>
            <label className={labelCls}>Name</label>
            <input
              type="text" placeholder="e.g. Terigu, White sauce, Risoles Smoke Beef Mayo"
              value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className={inputCls} required
            />
          </div>
          <div>
            <label className={labelCls}>Unit</label>
            <select value={form.unit_type} onChange={e => setForm({ ...form, unit_type: e.target.value })} className={inputCls} required>
              <option value="">Unit</option>
              {UNIT_TYPES.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Tier</label>
            <select value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })} className={inputCls}>
              {TIERS.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary px-5 py-2">Add</button>
        </form>
        <p className="mt-2 text-xs text-gray-500">{TIER_HINT[form.tier]}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[{ value: 'all', label: 'All', count: items.length }, ...TIERS.map(t => ({ value: t, label: TIER_LABEL[t], count: counts[t] }))]}
        />
        <input
          type="text" placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
          className="glass-input px-3 py-1.5 text-sm mb-4 w-full sm:w-56"
        />
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No items here yet.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className={`${thCls} text-left`}>Name</th>
                <th className={`${thCls} text-left`}>Tier</th>
                <th className={`${thCls} text-right`}>In stock</th>
                <th className={`${thCls} text-right`}>Stock value</th>
                <th className={`${thCls} text-right`}>Last cost</th>
                <th className={`${thCls} text-left`}>Recipes</th>
                <th className="px-4 py-3 w-28"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {visible.map(i => editingId === i.id ? (
                <EditRow
                  key={i.id}
                  item={i}
                  onSaved={saved => { setItems(prev => prev.map(x => x.id === saved.id ? saved : x)); setEditingId(null) }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <tr key={i.id} className="hover:bg-white/40 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium text-gray-800">{i.name}</td>
                  <td className="px-4 py-3"><TierBadge tier={i.tier} /></td>
                  <td className={`px-4 py-3 text-sm text-right ${i.stock_qty > 0 ? 'text-gray-700' : 'text-gray-400'}`}>
                    {qty(i.stock_qty)} {i.unit_type}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600">{i.stock_value > 0 ? rp(i.stock_value) : '—'}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600" title={i.last_price_date ? `${i.last_price_source} on ${i.last_price_date}` : ''}>
                    {i.last_unit_price != null ? `${unitRp(i.last_unit_price)}/${i.unit_type}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {i.recipe_count > 0 && <span className="mr-2">made by {i.recipe_count}</span>}
                    {i.used_in_count > 0 && <span>used in {i.used_in_count}</span>}
                    {!i.recipe_count && !i.used_in_count && '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => setEditingId(i.id)} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium mr-3">Edit</button>
                    <button onClick={() => handleDelete(i)} className="text-xs text-red-400 hover:text-red-600 font-medium">Delete</button>
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
