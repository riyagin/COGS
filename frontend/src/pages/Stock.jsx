import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { rp, qty, unitRp, TIERS, TIER_LABEL } from '../lib/format'
import { TierBadge, PageHeader, Tabs, thCls } from '../components/ui'

const PAGE_SIZE = 20

const SOURCE_STYLE = {
  purchase: 'bg-emerald-100 text-emerald-700',
  production: 'bg-purple-100 text-purple-700',
  adjustment: 'bg-amber-100 text-amber-700',
  opname: 'bg-sky-100 text-sky-700',
}

function OnHand({ stock, search }) {
  const q = search.trim().toLowerCase()
  const rows = stock.filter(s => !q || s.name.toLowerCase().includes(q))
  const totals = Object.fromEntries(TIERS.map(t => [t, stock.filter(s => s.tier === t).reduce((a, s) => a + s.total_value, 0)]))
  const grand = TIERS.reduce((a, t) => a + totals[t], 0)

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {TIERS.map(t => (
          <div key={t} className="glass-card px-4 py-3">
            <p className="text-xs text-gray-500">{TIER_LABEL[t]}</p>
            <p className="text-lg font-bold text-gray-800">{rp(totals[t])}</p>
          </div>
        ))}
        <div className="glass-card px-4 py-3 ring-1 ring-indigo-300/60">
          <p className="text-xs text-indigo-600">Total stock value</p>
          <p className="text-lg font-bold text-gray-800">{rp(grand)}</p>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/30 border-b border-white/60">
              <th className={`${thCls} text-left`}>Item</th>
              <th className={`${thCls} text-left`}>Tier</th>
              <th className={`${thCls} text-right`}>On hand</th>
              <th className={`${thCls} text-right`}>Avg cost</th>
              <th className={`${thCls} text-right`}>Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/50">
            {rows.map(s => (
              <tr key={s.id} className="hover:bg-white/40">
                <td className="px-4 py-2.5 font-medium text-gray-800">{s.name}</td>
                <td className="px-4 py-2.5"><TierBadge tier={s.tier} /></td>
                <td className={`px-4 py-2.5 text-right font-medium ${s.total_remaining > 0 ? 'text-gray-700' : 'text-red-400'}`}>
                  {qty(s.total_remaining)} {s.unit_type}
                </td>
                <td className="px-4 py-2.5 text-right text-gray-500">{s.total_remaining > 0 ? `${unitRp(s.avg_unit_price)}/${s.unit_type}` : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-700">{s.total_value > 0 ? rp(s.total_value) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Lots({ lots, search }) {
  const [page, setPage] = useState(1)
  const [openOnly, setOpenOnly] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lots.filter(l => (!q || l.item_name.toLowerCase().includes(q)) && (!openOnly || l.remaining > 0))
  }, [lots, search, openOnly])
  useEffect(() => { setPage(1) }, [search, openOnly])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-4 py-3 border-b border-white/50 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> Only lots with stock left
        </label>
        <span className="ml-auto">{filtered.length} lots · used oldest first (FIFO)</span>
      </div>
      {filtered.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">No lots.</div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="bg-white/30 border-b border-white/60">
              <th className={`${thCls} text-left`}>Item</th>
              <th className={`${thCls} text-left`}>Date</th>
              <th className={`${thCls} text-right`}>Amount</th>
              <th className={`${thCls} text-right`}>Remaining</th>
              <th className={`${thCls} text-right`}>Lot cost</th>
              <th className={`${thCls} text-right`}>Unit cost</th>
              <th className={`${thCls} text-left`}>Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/50">
            {pageItems.map(l => {
              const pctLeft = l.amount > 0 ? l.remaining / l.amount : 0
              const color = l.remaining <= 0 ? 'text-gray-400' : pctLeft < 0.2 ? 'text-amber-600' : 'text-emerald-600'
              return (
                <tr key={l.id} className="hover:bg-white/40">
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-800">{l.item_name}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-500">{l.date_of_purchase}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 text-right">{qty(l.amount)} {l.unit_type}</td>
                  <td className={`px-4 py-2.5 text-sm text-right font-medium ${color}`}>{qty(l.remaining)} {l.unit_type}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 text-right">{rp(l.price)}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 text-right">{unitRp(l.unit_price)}/{l.unit_type}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${SOURCE_STYLE[l.source] || 'bg-gray-100 text-gray-600'}`}>
                      {l.source}
                    </span>
                    {l.note && <span className="ml-2 text-xs text-gray-400">{l.note}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-white/50 flex items-center justify-between text-xs text-gray-500">
          <span>Page {safePage} of {totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1} className="px-3 py-1 rounded hover:bg-white/50 disabled:opacity-30">‹ Newer</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} className="px-3 py-1 rounded hover:bg-white/50 disabled:opacity-30">Older ›</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Stock() {
  const [stock, setStock] = useState([])
  const [lots, setLots] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('onhand')
  const [search, setSearch] = useState('')

  useEffect(() => {
    Promise.all([apiFetch('/api/inventory/stock').then(r => r.json()), apiFetch('/api/inventory').then(r => r.json())])
      .then(([s, l]) => { setStock(s); setLots(l); setLoading(false) })
  }, [])

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Stock" subtitle="What's on hand and what it's worth">
        <Link to="/purchasing" className="btn-primary inline-block px-4 py-2">+ Record Purchase</Link>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'onhand', label: 'On hand' }, { value: 'lots', label: 'Lots' }]} />
        <input type="text" placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
          className="glass-input px-3 py-1.5 text-sm mb-4 w-full sm:w-56" />
      </div>
      {loading ? (
        <div className="glass-card p-8 text-center text-gray-400 text-sm">Loading...</div>
      ) : tab === 'onhand' ? <OnHand stock={stock} search={search} /> : <Lots lots={lots} search={search} />}
    </div>
  )
}
