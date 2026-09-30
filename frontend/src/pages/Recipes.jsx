import { useState, useEffect } from 'react'
import { apiFetch, apiDownload } from '../lib/api'
import { num, qty, rp, unitRp, dateTime, shortDate } from '../lib/format'
import { Alert, ItemSelect, TierBadge, PageHeader, SectionTitle, Tabs, inputCls, labelCls, secondaryBtn, jsonOrThrow } from '../components/ui'

function RecipeForm({ items, recipe, initialData, onSave, onCancel }) {
  const [form, setForm] = useState(() => {
    const source = recipe || initialData
    if (source) {
      return {
        name: source.name,
        output_item_id: String(source.output_item_id),
        items_per_batch: String(source.items_per_batch),
        items: (source.items || []).map(i => ({
          item_id: String(i.item_id),
          quantity_per_batch: String(i.quantity_per_batch),
        })),
      }
    }
    return { name: '', output_item_id: '', items_per_batch: '', items: [{ item_id: '', quantity_per_batch: '' }] }
  })
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const output = items.find(i => i.id === Number(form.output_item_id))

  function updateIngredient(idx, field, value) {
    setForm(f => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, [field]: value } : it) }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const payload = {
      name: form.name,
      note,
      output_item_id: parseInt(form.output_item_id),
      items_per_batch: parseFloat(form.items_per_batch),
      items: form.items.map(i => ({ item_id: parseInt(i.item_id), quantity_per_batch: parseFloat(i.quantity_per_batch) })),
    }
    try {
      onSave(await jsonOrThrow(await apiFetch(recipe ? `/api/recipes/${recipe.id}` : '/api/recipes', {
        method: recipe ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })))
    } catch (err) { setError(err.message) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Alert onClose={() => setError('')}>{error}</Alert>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>Recipe Name</label>
          {recipe ? (
            <p className="px-3 py-2 text-sm font-medium text-gray-800" title="The name stays the same across versions">{recipe.name}</p>
          ) : (
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} required />
          )}
        </div>
        <div>
          <label className={labelCls}>Makes</label>
          <ItemSelect
            items={items} value={form.output_item_id} tiers={['preprocessed', 'final']} placeholder="Select output"
            onChange={v => setForm(f => ({ ...f, output_item_id: v }))}
          />
        </div>
        <div>
          <label className={labelCls}>Yield per Batch{output ? ` (${output.unit_type})` : ''}</label>
          <input
            type="number" step="any" min="0.001" placeholder="e.g. 20"
            value={form.items_per_batch} onChange={e => setForm(f => ({ ...f, items_per_batch: e.target.value }))}
            className={inputCls} required
          />
        </div>
      </div>
      <p className="-mt-3 text-xs text-gray-500">
        Recipes make preprocessed items (used in other recipes) or final goods. Missing one? Add it on the Items page with the right tier.
      </p>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">Ingredients per batch</span>
          <button type="button" onClick={() => setForm(f => ({ ...f, items: [...f.items, { item_id: '', quantity_per_batch: '' }] }))}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">+ Add Row</button>
        </div>
        <div className="space-y-2">
          {form.items.map((row, idx) => {
            const item = items.find(i => i.id === Number(row.item_id))
            return (
              <div key={idx} className="flex gap-2 items-center">
                <div className="flex-1 min-w-0">
                  <ItemSelect
                    items={items} value={row.item_id} tiers={['raw', 'preprocessed']} placeholder="Select ingredient"
                    exclude={output ? [output.id] : []}
                    onChange={v => updateIngredient(idx, 'item_id', v)}
                  />
                </div>
                <input
                  type="number" step="any" min="0" placeholder="0.00" value={row.quantity_per_batch}
                  onChange={e => updateIngredient(idx, 'quantity_per_batch', e.target.value)}
                  className="w-28 glass-input px-2 py-2 text-sm" required
                />
                <span className="w-12 text-xs text-gray-500">{item?.unit_type}</span>
                {form.items.length > 1 && (
                  <button type="button" onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))}
                    className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none">×</button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <label className={labelCls}>{recipe ? 'What changed?' : 'Note'} <span className="font-normal text-gray-400">(optional)</span></label>
        <input
          value={note} onChange={e => setNote(e.target.value)} className={inputCls}
          placeholder={recipe ? 'e.g. Less salt, bigger batch, switched to Sakura mayo' : 'First version'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary px-5 py-2">
          {recipe ? `Save as Version ${recipe.version_count + 1}` : 'Create Recipe'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className={secondaryBtn}>Cancel</button>}
        {recipe && <span className="text-xs text-gray-500">Version {recipe.version_no} stays in the history.</span>}
      </div>
    </form>
  )
}

// A recipe expanded through its preprocessed ingredients, with expected costs
function TreeRows({ node, depth = 0 }) {
  return node.ingredients.map(ing => (
    <FragmentRows key={`${depth}-${ing.item_id}`} ing={ing} depth={depth} />
  ))
}

function FragmentRows({ ing, depth }) {
  const [open, setOpen] = useState(depth === 0)
  return (
    <>
      <tr className={depth > 0 ? 'bg-white/20' : ''}>
        <td className="py-1.5 pr-2 text-gray-700" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          {ing.sub ? (
            <button type="button" onClick={() => setOpen(o => !o)} className="text-left">
              <span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>
              <span className="font-medium">{ing.name}</span>
            </button>
          ) : <span className={depth > 0 ? 'text-gray-600' : ''}>{ing.name}</span>}
          {ing.tier !== 'raw' && <span className="ml-2"><TierBadge tier={ing.tier} short /></span>}
          {ing.sub && <span className="ml-2 text-xs text-gray-400">via {ing.sub.recipe_name} ({num(ing.sub.batches, 2)} batch)</span>}
        </td>
        <td className="py-1.5 text-right text-gray-600 whitespace-nowrap">{qty(ing.quantity)} {ing.unit_type}</td>
        <td className="py-1.5 text-right text-gray-400 whitespace-nowrap">{ing.unit_cost ? `${unitRp(ing.unit_cost)}/${ing.unit_type}` : '—'}</td>
        <td className="py-1.5 text-right text-gray-700 whitespace-nowrap">
          {ing.price_missing ? <span className="text-amber-600" title="No purchase price yet for this or something inside it">{rp(ing.cost)} *</span> : rp(ing.cost)}
        </td>
      </tr>
      {ing.sub && open && <TreeRows node={ing.sub} depth={depth + 1} />}
    </>
  )
}

function RecipeTree({ recipeId }) {
  const [tree, setTree] = useState(null)
  useEffect(() => { apiFetch(`/api/recipes/${recipeId}/tree`).then(r => r.json()).then(setTree) }, [recipeId])
  if (!tree) return <p className="text-sm text-gray-400">Loading ingredients...</p>
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-white/50">
            <th className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Ingredient</th>
            <th className="pb-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Per batch</th>
            <th className="pb-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit cost</th>
            <th className="pb-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/40">
          <TreeRows node={tree} />
        </tbody>
        <tfoot className="border-t border-white/60">
          <tr>
            <td colSpan={3} className="pt-2 text-right text-xs font-semibold text-gray-600">Batch cost ({qty(tree.output_qty)} {tree.unit_type})</td>
            <td className="pt-2 text-right font-bold text-gray-800">{rp(tree.total_cost)}</td>
          </tr>
          <tr>
            <td colSpan={3} className="text-right text-xs font-semibold text-gray-600">Per {tree.unit_type}</td>
            <td className="text-right font-bold text-indigo-600">{unitRp(tree.unit_cost)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-2 text-xs text-gray-400">
        Expected cost at last purchase prices. Preprocessed ingredients are costed through their own recipe (tap ▸ to see it).
      </p>
    </>
  )
}

// What changed from `older` to `newer`: yield, output and each ingredient
function versionChanges(older, newer) {
  const changes = []
  if (older.output_item_id !== newer.output_item_id) changes.push({ kind: 'changed', text: `Makes ${newer.output_item_name} (was ${older.output_item_name})` })
  if (older.items_per_batch !== newer.items_per_batch) {
    changes.push({ kind: 'changed', text: `Yield ${qty(older.items_per_batch)} → ${qty(newer.items_per_batch)} ${newer.output_unit_type}` })
  }
  const before = new Map(older.items.map(i => [i.item_id, i]))
  const after = new Map(newer.items.map(i => [i.item_id, i]))
  for (const i of newer.items) {
    const was = before.get(i.item_id)
    if (!was) changes.push({ kind: 'added', text: `${i.item_name} ${qty(i.quantity_per_batch)} ${i.unit_type}` })
    else if (was.quantity_per_batch !== i.quantity_per_batch) {
      changes.push({ kind: 'changed', text: `${i.item_name} ${qty(was.quantity_per_batch)} → ${qty(i.quantity_per_batch)} ${i.unit_type}` })
    }
  }
  for (const i of older.items) {
    if (!after.has(i.item_id)) changes.push({ kind: 'removed', text: `${i.item_name} ${qty(i.quantity_per_batch)} ${i.unit_type}` })
  }
  return changes
}

const CHANGE_STYLE = {
  added: ['+', 'text-emerald-700'],
  removed: ['−', 'text-red-600 line-through decoration-red-300'],
  changed: ['~', 'text-amber-700'],
}

function VersionHistory({ recipeId, onRestored }) {
  const [versions, setVersions] = useState(null)
  const [openId, setOpenId] = useState(null)
  const load = () => apiFetch(`/api/recipes/${recipeId}/versions`).then(r => r.json()).then(setVersions)
  useEffect(() => { load() }, [recipeId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function restore(v) {
    if (!confirm(`Restore version ${v.version_no}? It is saved as a new version; nothing is deleted.`)) return
    try {
      await jsonOrThrow(await apiFetch(`/api/recipes/${recipeId}/versions/${v.id}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }))
      load()
      onRestored()
    } catch (err) { alert(err.message) }
  }

  if (!versions) return <p className="text-sm text-gray-400">Loading history...</p>
  return (
    <ol className="space-y-3">
      {versions.map((v, idx) => {
        const older = versions[idx + 1]
        const changes = older ? versionChanges(older, v) : []
        return (
          <li key={v.id} className={`rounded-xl border p-3 ${v.is_current ? 'border-indigo-200 bg-indigo-50/50' : 'border-white/60 bg-white/25'}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm">
                <span className="font-semibold text-gray-800">Version {v.version_no}</span>
                {v.is_current && <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700">in use</span>}
                <span className="ml-2 text-gray-500">{dateTime(v.created_at)}</span>
                <span className="ml-1 text-gray-500">· by {v.created_by_name || 'unknown'}</span>
              </p>
              <div className="flex items-center gap-3 text-xs">
                {v.run_count > 0 && <span className="text-gray-400">{v.run_count} production run{v.run_count === 1 ? '' : 's'}</span>}
                <button onClick={() => setOpenId(o => o === v.id ? null : v.id)} className="text-indigo-500 hover:text-indigo-700 font-medium">
                  {openId === v.id ? 'Hide' : 'Ingredients'}
                </button>
                {!v.is_current && <button onClick={() => restore(v)} className="text-emerald-600 hover:text-emerald-800 font-medium">Restore</button>}
              </div>
            </div>
            {v.note && <p className="mt-1 text-sm text-gray-700 italic">“{v.note}”</p>}
            {changes.length > 0 && (
              <ul className="mt-2 text-xs space-y-0.5">
                {changes.map((c, i) => (
                  <li key={i} className={CHANGE_STYLE[c.kind][1]}><span className="inline-block w-3 font-bold no-underline">{CHANGE_STYLE[c.kind][0]}</span>{c.text}</li>
                ))}
              </ul>
            )}
            {openId === v.id && (
              <table className="mt-2 w-full text-xs">
                <tbody>
                  <tr className="text-gray-500"><td className="py-0.5">Makes</td><td className="py-0.5 text-right">{qty(v.items_per_batch)} {v.output_unit_type} {v.output_item_name}</td></tr>
                  {v.items.map(i => (
                    <tr key={i.id} className="border-t border-white/50">
                      <td className="py-1 text-gray-700">{i.item_name}</td>
                      <td className="py-1 text-right text-gray-600">{qty(i.quantity_per_batch)} {i.unit_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function RecipeDetail({ recipe, onRestored }) {
  const [tab, setTab] = useState('now')
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'now', label: `Version ${recipe.version_no}` },
        { value: 'history', label: 'History', count: recipe.version_count },
      ]} />
      {tab === 'now'
        ? <RecipeTree key={recipe.current_version_id} recipeId={recipe.id} />
        : <VersionHistory recipeId={recipe.id} onRestored={onRestored} />}
    </>
  )
}

export default function Recipes() {
  const [recipes, setRecipes] = useState([])
  const [items, setItems] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingRecipe, setEditingRecipe] = useState(null)
  const [copySource, setCopySource] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadRecipes = () => apiFetch('/api/recipes').then(r => r.json()).then(data => { setRecipes(data); setLoading(false) })
  useEffect(() => {
    loadRecipes()
    apiFetch('/api/items').then(r => r.json()).then(setItems)
  }, [])

  async function handleEdit(id) {
    const full = await apiFetch(`/api/recipes/${id}`).then(r => r.json())
    setEditingRecipe(full)
    setShowForm(false)
    setCopySource(null)
    setExpandedId(null)
  }

  async function handleCopy(id) {
    const full = await apiFetch(`/api/recipes/${id}`).then(r => r.json())
    setCopySource({ ...full, name: `${full.name} (Copy)` })
    setShowForm(true)
    setEditingRecipe(null)
    setExpandedId(null)
  }

  async function handleDelete(id) {
    if (!confirm('Delete this recipe?')) return
    try {
      await jsonOrThrow(await apiFetch(`/api/recipes/${id}`, { method: 'DELETE' }))
      setRecipes(prev => prev.filter(r => r.id !== id))
      if (expandedId === id) setExpandedId(null)
    } catch (err) { alert(err.message) }
  }

  function handleSave() {
    setEditingRecipe(null)
    setShowForm(false)
    setCopySource(null)
    loadRecipes() // costs and primary recipes may have changed
  }

  // Group by output tier so preprocessed recipes (white sauce, kulit) sit apart from finished goods
  const groups = [
    { tier: 'preprocessed', title: 'Preprocessed', list: recipes.filter(r => r.tier === 'preprocessed') },
    { tier: 'final', title: 'Final goods', list: recipes.filter(r => r.tier !== 'preprocessed') },
  ]
  const outputCounts = recipes.reduce((m, r) => m.set(r.output_item_id, (m.get(r.output_item_id) || 0) + 1), new Map())

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="Recipes" subtitle="Preprocessed items can go into other recipes, as many levels deep as needed">
        {!showForm && !editingRecipe && (
          <button onClick={() => { setShowForm(true); setCopySource(null) }} className="btn-primary px-4 py-2">+ New Recipe</button>
        )}
      </PageHeader>

      {showForm && (
        <div className="glass-card p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4">{copySource ? `Copy of ${copySource.name.replace(/ \(Copy\)$/, '')}` : 'New Recipe'}</SectionTitle>
          <RecipeForm
            key={copySource?.id ?? 'new'}
            items={items}
            initialData={copySource}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setCopySource(null) }}
          />
        </div>
      )}

      {editingRecipe && (
        <div className="glass-card ring-1 ring-indigo-300/60 p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4 !text-indigo-600">
            New version of {editingRecipe.name} <span className="normal-case font-normal text-gray-500">(now on version {editingRecipe.version_no})</span>
          </SectionTitle>
          <RecipeForm items={items} recipe={editingRecipe} onSave={handleSave} onCancel={() => setEditingRecipe(null)} />
        </div>
      )}

      {loading ? (
        <div className="glass-card p-8 text-center text-gray-400 text-sm">Loading...</div>
      ) : recipes.length === 0 ? (
        <div className="glass-card p-8 text-center text-gray-400 text-sm">No recipes yet.</div>
      ) : groups.filter(g => g.list.length > 0).map(g => (
        <div key={g.tier} className="mb-6">
          <SectionTitle className="mb-2 px-1">{g.title}</SectionTitle>
          <div className="space-y-2">
            {g.list.map(recipe => (
              <div key={recipe.id} className="glass-card overflow-hidden">
                <div
                  className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-4 cursor-pointer hover:bg-white/40 transition-colors select-none"
                  onClick={() => setExpandedId(id => id === recipe.id ? null : recipe.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-gray-400 text-sm">{expandedId === recipe.id ? '▲' : '▼'}</span>
                    <div className="min-w-0">
                      <span className="font-semibold text-gray-800">{recipe.name}</span>
                      <span className="ml-2 text-xs font-medium text-gray-400">v{recipe.version_no}</span>
                      {outputCounts.get(recipe.output_item_id) > 1 && recipe.is_primary && (
                        <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700"
                          title="Newest recipe for this item: used when it's made automatically during production">current</span>
                      )}
                      <p className="text-sm text-gray-500">
                        → {recipe.output_item_name} · {num(recipe.items_per_batch)} {recipe.unit_type} per batch
                        {recipe.has_sub_recipes && ' · uses preprocessed items'}
                        {recipe.unit_cost > 0 && <span className="text-gray-400"> · ≈ {unitRp(recipe.unit_cost)}/{recipe.unit_type}</span>}
                      </p>
                      <p className="text-xs text-gray-400">
                        Updated {shortDate(recipe.updated_at)}{recipe.updated_by_name && ` by ${recipe.updated_by_name}`}
                        {recipe.version_count > 1 && recipe.version_note && ` · “${recipe.version_note}”`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        apiDownload(`/api/recipes/${recipe.id}/word`, `${recipe.name}.docx`).catch(err => alert(err.message))
                      }}
                      className="text-xs text-emerald-600 hover:text-emerald-800 font-medium transition-colors"
                    >
                      Download Word
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleEdit(recipe.id) }} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">New version</button>
                    <button onClick={e => { e.stopPropagation(); handleCopy(recipe.id) }} className="text-xs text-gray-500 hover:text-gray-700 font-medium">Copy</button>
                    <button onClick={e => { e.stopPropagation(); handleDelete(recipe.id) }} className="text-xs text-red-400 hover:text-red-600 font-medium">Delete</button>
                  </div>
                </div>

                {expandedId === recipe.id && (
                  <div className="border-t border-white/50 px-4 sm:px-5 pb-4 pt-3">
                    <RecipeDetail recipe={recipe} onRestored={loadRecipes} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
