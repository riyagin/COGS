import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { num, qty, rp, unitRp, today } from '../lib/format'
import { Alert, TierBadge, PageHeader, SectionTitle, inputCls, labelCls, thCls, jsonOrThrow } from '../components/ui'

// Every sub-run in a plan, deepest first (the order they are made in)
function subRuns(node, acc = []) {
  for (const ing of node.ingredients) {
    if (ing.sub) { subRuns(ing.sub, acc); acc.push(ing.sub) }
  }
  return acc
}

function PlanRows({ node, depth = 0 }) {
  return node.ingredients.map(ing => {
    const status = ing.sufficient
      ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">OK</span>
      : ing.sub
        ? <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${ing.covered ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-600'}`}>
            {ing.covered ? 'Make' : 'Can\'t make'} {qty(ing.sub.output_qty)}
          </span>
        : <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-600">
            Short {qty(ing.shortfall)}
          </span>
    return [
      <tr key={`${depth}-${ing.item_id}`} className={!ing.covered ? 'bg-red-50/60' : depth > 0 ? 'bg-white/20' : ''}>
        <td className="px-4 py-2 font-medium text-gray-800" style={{ paddingLeft: `${1 + depth * 1.25}rem` }}>
          {depth > 0 && <span className="text-gray-300 mr-1">└</span>}
          {ing.name}
          {ing.tier !== 'raw' && <span className="ml-2"><TierBadge tier={ing.tier} short /></span>}
          {!ing.sufficient && !ing.sub && ing.has_recipe && (
            <span className="ml-2 text-xs text-gray-400">(has a recipe: turn on “make missing”)</span>
          )}
        </td>
        <td className="px-4 py-2 text-right text-gray-600 whitespace-nowrap">{qty(ing.needed)} {ing.unit_type}</td>
        <td className={`px-4 py-2 text-right whitespace-nowrap ${ing.sufficient ? 'text-emerald-600' : 'text-red-500'}`}>{qty(ing.in_stock)} {ing.unit_type}</td>
        <td className="px-4 py-2 text-right text-gray-700 whitespace-nowrap">{rp(ing.cost)}</td>
        <td className="px-4 py-2 text-center">{status}</td>
      </tr>,
      ing.sub && (
        <tr key={`${depth}-${ing.item_id}-sub`} className="bg-white/20">
          <td colSpan={5} className="px-4 py-1 text-xs text-amber-700" style={{ paddingLeft: `${2 + depth * 1.25}rem` }}>
            ↳ {ing.sub.recipe_name}: {num(ing.sub.batches, 2)} batch → {qty(ing.sub.output_qty)} {ing.sub.unit_type} {ing.sub.output_name}
          </td>
        </tr>
      ),
      ing.sub && <PlanRows key={`${depth}-${ing.item_id}-rows`} node={ing.sub} depth={depth + 1} />,
    ]
  })
}

export default function Production() {
  const [recipes, setRecipes] = useState([])
  const [recipeId, setRecipeId] = useState('')
  const [batches, setBatches] = useState('')
  const [dateProduced, setDateProduced] = useState(today())
  const [autoProduce, setAutoProduce] = useState(true)
  const [wholeBatches, setWholeBatches] = useState(true)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [history, setHistory] = useState([])

  const fetchHistory = () => apiFetch('/api/production').then(r => r.json()).then(setHistory)
  useEffect(() => {
    apiFetch('/api/recipes').then(r => r.json()).then(setRecipes)
    fetchHistory()
  }, [])

  // Debounced preview
  useEffect(() => {
    const b = parseFloat(batches)
    if (!recipeId || isNaN(b) || b <= 0) { setPreview(null); return }
    setPreviewLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ recipe_id: recipeId, batches, auto_produce: autoProduce ? '1' : '0', whole_batches: wholeBatches ? '1' : '0' })
        setPreview(await jsonOrThrow(await apiFetch(`/api/production/preview?${params}`)))
        setError('')
      } catch (err) {
        setError(err.message)
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [recipeId, batches, autoProduce, wholeBatches])

  async function handleSubmit() {
    if (!preview?.ok) return
    setSubmitting(true)
    setError('')
    try {
      const data = await jsonOrThrow(await apiFetch('/api/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe_id: recipeId, batches, date_produced: dateProduced, auto_produce: autoProduce, whole_batches: wholeBatches }),
      }))
      const also = data.sub_runs.length ? ` (also made ${data.sub_runs.map(s => `${qty(s.items_produced)} ${s.unit_type} ${s.output_item_name}`).join(', ')})` : ''
      setSuccess(`Recorded: ${qty(data.items_produced)} ${data.unit_type} ${data.output_item_name} at ${unitRp(data.unit_cost)}/${data.unit_type}${also}`)
      setRecipeId('')
      setBatches('')
      setPreview(null)
      fetchHistory()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const extra = preview ? subRuns(preview) : []
  const byName = (a, b) => a.name.localeCompare(b.name)
  const recipeGroups = [
    ['Final goods', recipes.filter(r => r.tier !== 'preprocessed').sort(byName)],
    ['Preprocessed', recipes.filter(r => r.tier === 'preprocessed').sort(byName)],
  ]

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader title="Production" subtitle="Turn ingredients into preprocessed items and finished goods" />

      <div className="glass-card p-4 sm:p-6 mb-6">
        <SectionTitle className="mb-4">New Production Run</SectionTitle>
        <Alert onClose={() => setError('')}>{error}</Alert>
        <Alert kind="success" onClose={() => setSuccess('')}>{success}</Alert>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3">
          <div>
            <label className={labelCls}>Recipe</label>
            <select value={recipeId} onChange={e => { setRecipeId(e.target.value); setSuccess('') }} className={inputCls}>
              <option value="">Select recipe</option>
              {recipeGroups.map(([label, list]) => list.length > 0 && (
                <optgroup key={label} label={label}>
                  {list.map(r => <option key={r.id} value={r.id}>{r.name} → {r.output_item_name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Number of Batches</label>
            <input type="number" step="any" min="0.001" placeholder="e.g. 2.5" value={batches}
              onChange={e => { setBatches(e.target.value); setSuccess('') }} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Production Date</label>
            <input type="date" value={dateProduced} onChange={e => setDateProduced(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 mb-6 text-sm text-gray-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoProduce} onChange={e => setAutoProduce(e.target.checked)} />
            Make missing preprocessed items from their recipes
          </label>
          {autoProduce && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={wholeBatches} onChange={e => setWholeBatches(e.target.checked)} />
              in whole batches (extra goes to stock)
            </label>
          )}
        </div>

        {previewLoading && <div className="text-center text-sm text-gray-400 py-6">Calculating costs...</div>}

        {preview && !previewLoading && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <p className="text-sm font-semibold text-gray-700">
                  Producing <span className="text-indigo-600">{qty(preview.output_qty)} {preview.unit_type} {preview.output_name}</span>
                  {' '}({num(preview.batches, 2)} {preview.batches === 1 ? 'batch' : 'batches'})
                </p>
                {extra.length > 0 && (
                  <p className="text-xs text-amber-700 mt-0.5">
                    Also makes first: {extra.map(s => `${qty(s.output_qty)} ${s.unit_type} ${s.output_name}`).join(', ')}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Estimated cost</p>
                <p className="text-lg font-bold text-gray-800">{rp(preview.total_cost)} <span className="text-sm font-semibold text-indigo-600">· {unitRp(preview.unit_cost)}/{preview.unit_type}</span></p>
              </div>
            </div>

            <div className="border border-white/60 rounded-lg overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white/30 border-b border-white/60">
                    <th className={`${thCls} text-left`}>Ingredient</th>
                    <th className={`${thCls} text-right`}>Needed</th>
                    <th className={`${thCls} text-right`}>In Stock</th>
                    <th className={`${thCls} text-right`}>Est. Cost</th>
                    <th className={`${thCls} text-center w-32`}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/50">
                  <PlanRows node={preview} />
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={handleSubmit}
                disabled={submitting || !preview.ok}
                className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  preview.ok && !submitting
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-[0_4px_14px_rgba(16,185,129,0.35)] hover:from-emerald-600 hover:to-teal-600'
                    : 'bg-white/60 text-gray-400 cursor-not-allowed'
                }`}
              >
                {submitting ? 'Recording...' : extra.length ? `Confirm ${extra.length + 1} runs` : 'Confirm Production'}
              </button>
              {!preview.ok && <p className="text-xs text-red-500 font-medium">Not enough stock. Buy the missing raw materials first.</p>}
              <p className="text-xs text-gray-400 w-full">Estimate uses the average cost of stock on hand; the recorded run uses the actual lots, oldest first.</p>
            </div>
          </div>
        )}
      </div>

      <div className="glass-card overflow-hidden">
        <div className="px-4 sm:px-6 py-4 border-b border-white/50 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Production History</SectionTitle>
          <span className="text-xs text-gray-400">{history.length} runs</span>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No production runs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className={`${thCls} text-left`}>Date</th>
                <th className={`${thCls} text-left`}>Recipe</th>
                <th className={`${thCls} text-left`}>Output</th>
                <th className={`${thCls} text-right`}>Batches</th>
                <th className={`${thCls} text-right`}>Produced</th>
                <th className={`${thCls} text-right`}>Total Cost</th>
                <th className={`${thCls} text-right`}>Unit Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {history.map(p => (
                <tr key={p.id} className="hover:bg-white/40 transition-colors">
                  <td className="px-4 py-3 text-gray-500">{p.date_produced}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {p.recipe_name}
                    {p.version_no && <span className="ml-1.5 text-xs font-normal text-gray-400">v{p.version_no}</span>}
                    {p.parent_production_id && (
                      <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-700" title={`Made automatically for run #${p.parent_production_id}`}>auto</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.output_item_name} <TierBadge tier={p.tier} short /></td>
                  <td className="px-4 py-3 text-right text-gray-600">{num(p.batches, 2)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{qty(p.items_produced)} {p.unit_type}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{rp(p.total_cost)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-indigo-600">{unitRp(p.unit_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
