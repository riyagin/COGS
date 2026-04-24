import { useState, useEffect } from 'react'

const today = () => new Date().toISOString().split('T')[0]

// Plain number formatter (for quantities)
function num(n, decimals = 2) {
  return Number(n).toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// Currency formatter (Rupiah)
function rp(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

export default function Production() {
  const [recipes, setRecipes] = useState([])
  const [selectedRecipeId, setSelectedRecipeId] = useState('')
  const [batches, setBatches] = useState('')
  const [dateProduced, setDateProduced] = useState(today())
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [history, setHistory] = useState([])

  useEffect(() => {
    fetch('/api/recipes').then(r => r.json()).then(setRecipes)
    fetchHistory()
  }, [])

  // Debounced preview fetch
  useEffect(() => {
    const batchNum = parseFloat(batches)
    if (!selectedRecipeId || !batches || isNaN(batchNum) || batchNum <= 0) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/production/preview?recipe_id=${selectedRecipeId}&batches=${batches}`)
        const data = await res.json()
        if (!res.ok) { setError(data.error); setPreview(null) }
        else { setPreview(data); setError('') }
      } catch {
        setError('Failed to load preview')
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [selectedRecipeId, batches])

  async function fetchHistory() {
    const data = await fetch('/api/production').then(r => r.json())
    setHistory(data)
  }

  async function handleSubmit() {
    if (!preview) return
    const insufficient = preview.ingredients.filter(i => !i.sufficient)
    if (insufficient.length > 0) {
      return setError(`Insufficient stock for: ${insufficient.map(i => i.product_name).join(', ')}`)
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe_id: selectedRecipeId, batches, date_produced: dateProduced }),
      })
      const data = await res.json()
      if (!res.ok) return setError(data.error)

      setSuccess(
        `Recorded: ${num(data.items_produced, 2)} ${data.output_product_name} produced at ${rp(data.unit_cost)}/unit`
      )
      setSelectedRecipeId('')
      setBatches('')
      setPreview(null)
      fetchHistory()
    } catch {
      setError('Failed to record production')
    } finally {
      setSubmitting(false)
    }
  }

  const allSufficient = preview?.ingredients.every(i => i.sufficient)

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Production</h2>

      {/* Input panel */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">New Production Run</h3>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-md">{error}</div>
        )}
        {success && (
          <div className="mb-4 text-sm text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-md">{success}</div>
        )}

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Recipe</label>
            <select
              value={selectedRecipeId}
              onChange={e => { setSelectedRecipeId(e.target.value); setSuccess(''); setError('') }}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select recipe</option>
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Number of Batches</label>
            <input
              type="number"
              step="any"
              min="0.001"
              placeholder="e.g. 2.5"
              value={batches}
              onChange={e => { setBatches(e.target.value); setSuccess(''); setError('') }}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Production Date</label>
            <input
              type="date"
              value={dateProduced}
              onChange={e => setDateProduced(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Preview */}
        {previewLoading && (
          <div className="text-center text-sm text-gray-400 py-6">Calculating costs...</div>
        )}

        {preview && !previewLoading && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">
                Producing{' '}
                <span className="text-blue-600">{num(preview.items_produced, 2)} {preview.recipe.output_product_name}</span>
                {' '}({preview.batches} {preview.batches === 1 ? 'batch' : 'batches'})
              </p>
              <div className="text-right">
                <p className="text-xs text-gray-500">Total Cost</p>
                <p className="text-lg font-bold text-gray-800">{rp(preview.total_cost)}</p>
              </div>
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Ingredient</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Qty Needed</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">In Stock</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Avg Unit Price</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Item Cost</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {preview.ingredients.map(ing => (
                    <tr key={ing.product_id} className={!ing.sufficient ? 'bg-red-50' : ''}>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{ing.product_name}</td>
                      <td className="px-4 py-2.5 text-right text-gray-600">
                        {num(ing.quantity_needed)} {ing.unit_type}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium ${ing.sufficient ? 'text-emerald-600' : 'text-red-500'}`}>
                        {num(ing.total_remaining)} {ing.unit_type}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-600">
                        {rp(ing.avg_unit_price)}/{ing.unit_type}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700 font-medium">
                        {rp(ing.item_cost)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {ing.sufficient ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
                            OK
                          </span>
                        ) : (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-600">
                            Low Stock
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                  <tr>
                    <td colSpan="4" className="px-4 py-2.5 text-right text-sm font-semibold text-gray-600">Total Cost</td>
                    <td className="px-4 py-2.5 text-right text-sm font-bold text-gray-800">{rp(preview.total_cost)}</td>
                    <td></td>
                  </tr>
                  <tr>
                    <td colSpan="4" className="px-4 py-2.5 text-right text-sm font-semibold text-gray-600">Cost per Unit</td>
                    <td className="px-4 py-2.5 text-right text-sm font-bold text-blue-600">{rp(preview.unit_cost)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={handleSubmit}
                disabled={submitting || !allSufficient}
                className={`px-6 py-2 rounded-md text-sm font-semibold transition-colors ${
                  allSufficient && !submitting
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                {submitting ? 'Recording...' : 'Confirm Production'}
              </button>
              {!allSufficient && (
                <p className="text-xs text-red-500 font-medium">Resolve stock issues before confirming.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Production History</h3>
          <span className="text-xs text-gray-400">{history.length} runs</span>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No production runs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Recipe</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Output</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Batches</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Units Produced</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Cost</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-500">{p.date_produced}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{p.recipe_name}</td>
                  <td className="px-4 py-3 text-gray-600">{p.output_product_name}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{p.batches}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{num(p.items_produced, 2)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{rp(p.total_cost)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-blue-600">{rp(p.unit_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
