import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

function rp(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

export default function Invoices() {
  const [invoices, setInvoices] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchInvoices()
  }, [])

  function fetchInvoices() {
    setLoading(true)
    apiFetch('/api/invoices')
      .then(r => r.json())
      .then(data => { setInvoices(data); setLoading(false) })
      .catch(() => setLoading(false))
  }

  function handleDelete(id) {
    if (!confirm('Delete this invoice?')) return
    apiFetch(`/api/invoices/${id}`, { method: 'DELETE' })
      .then(() => setInvoices(prev => prev.filter(inv => inv.id !== id)))
  }

  function toggleExpand(id) {
    setExpanded(prev => prev === id ? null : id)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Invoices</h2>
          <p className="text-sm text-gray-500 mt-0.5">Invoice history from the POS terminal</p>
        </div>
        <span className="text-sm text-gray-400">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      )}

      {!loading && invoices.length === 0 && (
        <div className="glass-card p-12 text-center">
          <p className="text-gray-400 text-sm">No invoices yet. Print one from the POS app.</p>
        </div>
      )}

      {!loading && invoices.length > 0 && (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/60 bg-white/30">
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Invoice #</th>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Date</th>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Customer</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Subtotal</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Discount</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Total</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <>
                  <tr
                    key={inv.id}
                    className="border-b border-white/50 hover:bg-white/40 cursor-pointer"
                    onClick={() => toggleExpand(inv.id)}
                  >
                    <td className="px-5 py-3 font-medium text-gray-800">
                      <span className="mr-2 text-gray-400">{expanded === inv.id ? '▾' : '▸'}</span>
                      {inv.invoice_num || '—'}
                    </td>
                    <td className="px-5 py-3 text-gray-600">{inv.date || '—'}</td>
                    <td className="px-5 py-3 text-gray-600">{inv.customer_name || '—'}</td>
                    <td className="px-5 py-3 text-right text-gray-700">{rp(inv.subtotal)}</td>
                    <td className="px-5 py-3 text-right text-red-500">
                      {inv.discount > 0 ? `- ${rp(inv.discount)}` : '—'}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">{rp(inv.total)}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        className="text-red-400 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50"
                        onClick={e => { e.stopPropagation(); handleDelete(inv.id) }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>

                  {expanded === inv.id && (
                    <tr key={`${inv.id}-detail`} className="bg-indigo-50/60 border-b border-white/50">
                      <td colSpan={7} className="px-8 py-4">
                        {inv.note && (
                          <p className="text-xs text-gray-500 mb-3">Note: {inv.note}</p>
                        )}
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500 border-b border-indigo-200/70">
                              <th className="text-left pb-2 font-semibold">Item</th>
                              <th className="text-right pb-2 font-semibold">Qty</th>
                              <th className="text-right pb-2 font-semibold">Unit Price</th>
                              <th className="text-right pb-2 font-semibold">Subtotal</th>
                            </tr>
                          </thead>
                          <tbody>
                            {inv.items.map(item => (
                              <tr key={item.id} className="border-b border-indigo-100/70 last:border-0">
                                <td className="py-1.5 text-gray-700">
                                  {item.description}
                                  {item.product_name && (
                                    <span className="ml-2 text-gray-400">({item.product_name})</span>
                                  )}
                                </td>
                                <td className="py-1.5 text-right text-gray-600">{item.qty}</td>
                                <td className="py-1.5 text-right text-gray-600">{rp(item.unit_price)}</td>
                                <td className="py-1.5 text-right text-gray-700 font-medium">{rp(item.subtotal)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-3 flex justify-end gap-8 text-xs text-gray-600 border-t border-indigo-200/70 pt-3">
                          <span>Subtotal: <strong>{rp(inv.subtotal)}</strong></span>
                          {inv.discount > 0 && (
                            <span className="text-red-500">
                              Discount ({inv.discount_pct}%): <strong>- {rp(inv.discount)}</strong>
                            </span>
                          )}
                          {inv.tax > 0 && (
                            <span>Tax: <strong>{rp(inv.tax)}</strong></span>
                          )}
                          <span className="text-gray-900 font-semibold">
                            Total: <strong>{rp(inv.total)}</strong>
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
