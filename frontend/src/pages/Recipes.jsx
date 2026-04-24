import { useState, useEffect } from 'react'

function RecipeForm({ products, recipe, onSave, onCancel }) {
  const [form, setForm] = useState(() => {
    if (recipe) {
      return {
        name: recipe.name,
        output_product_id: String(recipe.output_product_id),
        items_per_batch: String(recipe.items_per_batch),
        items: (recipe.items || []).map(i => ({
          product_id: String(i.product_id),
          quantity_per_batch: String(i.quantity_per_batch),
        })),
      }
    }
    return { name: '', output_product_id: '', items_per_batch: '', items: [{ product_id: '', quantity_per_batch: '' }] }
  })
  const [error, setError] = useState('')

  function addIngredient() {
    setForm(f => ({ ...f, items: [...f.items, { product_id: '', quantity_per_batch: '' }] }))
  }

  function removeIngredient(idx) {
    setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
  }

  function updateIngredient(idx, field, value) {
    setForm(f => {
      const items = [...f.items]
      items[idx] = { ...items[idx], [field]: value }
      return { ...f, items }
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const payload = {
      name: form.name,
      output_product_id: parseInt(form.output_product_id),
      items_per_batch: parseFloat(form.items_per_batch),
      items: form.items.map(i => ({
        product_id: parseInt(i.product_id),
        quantity_per_batch: parseFloat(i.quantity_per_batch),
      })),
    }
    const url = recipe ? `/api/recipes/${recipe.id}` : '/api/recipes'
    const method = recipe ? 'PUT' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    onSave(data)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-md">{error}</div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Recipe Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>
        <div className="col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Output Product</label>
          <select
            value={form.output_product_id}
            onChange={e => setForm(f => ({ ...f, output_product_id: e.target.value }))}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          >
            <option value="">Select product</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit_type})</option>)}
          </select>
        </div>
        <div className="col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Units Made per Batch</label>
          <input
            type="number"
            step="any"
            min="0.001"
            placeholder="e.g. 12"
            value={form.items_per_batch}
            onChange={e => setForm(f => ({ ...f, items_per_batch: e.target.value }))}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Ingredients</label>
          <button
            type="button"
            onClick={addIngredient}
            className="text-xs text-blue-600 hover:text-blue-800 font-semibold"
          >
            + Add Row
          </button>
        </div>
        <div className="border border-gray-200 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Ingredient</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 w-44">Qty per Batch</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {form.items.map((item, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-2">
                    <select
                      value={item.product_id}
                      onChange={e => updateIngredient(idx, 'product_id', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    >
                      <option value="">Select ingredient</option>
                      {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit_type})</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      placeholder="0.00"
                      value={item.quantity_per_batch}
                      onChange={e => updateIngredient(idx, 'quantity_per_batch', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {form.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeIngredient(idx)}
                        className="text-gray-400 hover:text-red-500 transition-colors text-base leading-none"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          className="bg-blue-600 text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          {recipe ? 'Update Recipe' : 'Create Recipe'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="bg-gray-100 text-gray-600 px-5 py-2 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

export default function Recipes() {
  const [recipes, setRecipes] = useState([])
  const [products, setProducts] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingRecipe, setEditingRecipe] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetch('/api/recipes').then(r => r.json()), fetch('/api/products').then(r => r.json())])
      .then(([rec, prod]) => { setRecipes(rec); setProducts(prod); setLoading(false) })
  }, [])

  async function toggleExpand(id) {
    if (expandedId === id) { setExpandedId(null); return }
    // Load with items if not already loaded
    const existing = recipes.find(r => r.id === id)
    if (!existing.items) {
      const full = await fetch(`/api/recipes/${id}`).then(r => r.json())
      setRecipes(prev => prev.map(r => r.id === id ? full : r))
    }
    setExpandedId(id)
  }

  async function handleEdit(id) {
    const full = await fetch(`/api/recipes/${id}`).then(r => r.json())
    setEditingRecipe(full)
    setShowForm(false)
    setExpandedId(null)
  }

  async function handleDelete(id) {
    if (!confirm('Delete this recipe?')) return
    const res = await fetch(`/api/recipes/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setRecipes(prev => prev.filter(r => r.id !== id))
      if (expandedId === id) setExpandedId(null)
    }
  }

  function handleSave(saved) {
    if (editingRecipe) {
      setRecipes(prev => prev.map(r => r.id === saved.id ? saved : r))
      setEditingRecipe(null)
    } else {
      setRecipes(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)))
      setShowForm(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Recipes</h2>
        {!showForm && !editingRecipe && (
          <button
            onClick={() => setShowForm(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + New Recipe
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-5">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">New Recipe</h3>
          <RecipeForm products={products} onSave={handleSave} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {editingRecipe && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 p-6 mb-5">
          <h3 className="text-sm font-semibold text-blue-600 uppercase tracking-wider mb-4">
            Editing: {editingRecipe.name}
          </h3>
          <RecipeForm products={products} recipe={editingRecipe} onSave={handleSave} onCancel={() => setEditingRecipe(null)} />
        </div>
      )}

      <div className="space-y-2">
        {loading ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-gray-400 text-sm">
            Loading...
          </div>
        ) : recipes.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center text-gray-400 text-sm">
            No recipes yet.
          </div>
        ) : (
          recipes.map(recipe => (
            <div key={recipe.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors select-none"
                onClick={() => toggleExpand(recipe.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-gray-300 text-sm">{expandedId === recipe.id ? '▲' : '▼'}</span>
                  <div>
                    <span className="font-semibold text-gray-800">{recipe.name}</span>
                    <span className="ml-3 text-sm text-gray-400">
                      → {recipe.output_product_name} · {recipe.items_per_batch} {recipe.unit_type} per batch
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <button
                    onClick={e => { e.stopPropagation(); handleEdit(recipe.id) }}
                    className="text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(recipe.id) }}
                    className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === recipe.id && (
                <div className="border-t border-gray-100 px-5 pb-4 pt-3">
                  {recipe.items && recipe.items.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b border-gray-100">
                          <th className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Ingredient</th>
                          <th className="pb-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Qty per Batch</th>
                          <th className="pb-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {recipe.items.map(item => (
                          <tr key={item.id}>
                            <td className="py-2 text-gray-700">{item.product_name}</td>
                            <td className="py-2 text-right text-gray-600">{item.quantity_per_batch}</td>
                            <td className="py-2 text-right text-gray-400">{item.unit_type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-gray-400">Loading ingredients...</p>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
