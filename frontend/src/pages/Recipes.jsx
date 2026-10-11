import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { apiFetch, apiDownload } from '../lib/api'
import { num, qty, rp, unitRp, dateTime, shortDate, TIER_LABEL, TIER_HINT, UNIT_TYPES } from '../lib/format'
import { Alert, ItemSelect, TierBadge, PageHeader, SectionTitle, Tabs, inputCls, labelCls, secondaryBtn, jsonOrThrow } from '../components/ui'

// Steps are stored one per line
const stepsOf = instructions => (instructions ? instructions.split('\n').filter(Boolean) : [])

// A textarea that grows with its text, so long instructions stay readable on a phone
function AutoTextarea({ value, onChange, className = '', ...props }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  return <textarea ref={ref} value={value} onChange={e => onChange(e.target.value)} className={`${inputCls} resize-none leading-relaxed ${className}`} {...props} />
}

// An item dropdown that can also register a new item on the spot, so a recipe can be
// written before its ingredients or output are on the Items page
function ItemField({ tiers, onChange, onCreated, ...props }) {
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const close = () => { setDraft(null); setError('') }

  async function create() {
    if (!draft.name.trim() || !draft.unit_type) return setError('Name and unit are needed')
    setBusy(true)
    setError('')
    try {
      const item = await jsonOrThrow(await apiFetch('/api/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      }))
      onCreated(item)
      onChange(String(item.id))
      close()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  if (!draft) {
    return <ItemSelect {...props} tiers={tiers} onChange={onChange} onNew={() => setDraft({ name: '', unit_type: '', tier: tiers[0] })} />
  }
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus value={draft.name} placeholder="New item name" onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); create() }
            if (e.key === 'Escape') close()
          }}
          className={`${inputCls} flex-1 min-w-[9rem]`}
        />
        <select value={draft.unit_type} onChange={e => setDraft(d => ({ ...d, unit_type: e.target.value }))} className="glass-input px-2 py-2 text-sm">
          <option value="">Unit</option>
          {UNIT_TYPES.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        {tiers.length > 1 && (
          <select value={draft.tier} onChange={e => setDraft(d => ({ ...d, tier: e.target.value }))} className="glass-input px-2 py-2 text-sm">
            {tiers.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
          </select>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" onClick={create} disabled={busy} className="font-semibold text-indigo-600 hover:text-indigo-800 py-1 disabled:opacity-50">
          {busy ? 'Adding...' : 'Add item'}
        </button>
        <button type="button" onClick={close} className="text-gray-500 hover:text-gray-700 py-1">Cancel</button>
        {error ? <span className="text-red-600">{error}</span> : <span className="text-gray-400">{TIER_HINT[draft.tier]}</span>}
      </div>
    </div>
  )
}

const emptyIngredient = () => ({ item_id: '', quantity_per_batch: '' })
const emptySection = (withIngredient = false) => ({ title: '', instructions: '', items: withIngredient ? [emptyIngredient()] : [] })

function RecipeForm({ items, recipe, initialData, onSave, onCancel, onItemCreated }) {
  const [form, setForm] = useState(() => {
    const source = recipe || initialData
    if (source) {
      const sections = source.sections?.length ? source.sections : [{ title: '', instructions: '', items: source.items || [] }]
      return {
        name: source.name,
        output_item_id: String(source.output_item_id),
        items_per_batch: String(source.items_per_batch),
        description: source.description || '',
        sections: sections.map(s => ({
          title: s.title || '',
          instructions: s.instructions || '',
          items: s.items.map(i => ({ item_id: String(i.item_id), quantity_per_batch: String(i.quantity_per_batch) })),
        })),
      }
    }
    return { name: '', output_item_id: '', items_per_batch: '', description: '', sections: [emptySection(true)] }
  })
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const output = items.find(i => i.id === Number(form.output_item_id))

  const updateSection = (idx, change) =>
    setForm(f => ({ ...f, sections: f.sections.map((s, i) => i === idx ? { ...s, ...change(s) } : s) }))
  const updateIngredient = (sIdx, iIdx, field, value) =>
    updateSection(sIdx, s => ({ items: s.items.map((it, i) => i === iIdx ? { ...it, [field]: value } : it) }))
  function moveSection(idx, by) {
    setForm(f => {
      const sections = [...f.sections]
      const [s] = sections.splice(idx, 1)
      sections.splice(idx + by, 0, s)
      return { ...f, sections }
    })
  }
  function removeSection(idx) {
    const s = form.sections[idx]
    if ((s.title || s.instructions || s.items.some(i => i.item_id)) && !confirm(`Remove the section${s.title ? ` "${s.title}"` : ''} and everything in it?`)) return
    setForm(f => ({ ...f, sections: f.sections.filter((_, i) => i !== idx) }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const payload = {
      name: form.name,
      note,
      output_item_id: parseInt(form.output_item_id),
      items_per_batch: parseFloat(form.items_per_batch),
      description: form.description,
      sections: form.sections.map(s => ({
        title: s.title,
        instructions: s.instructions,
        items: s.items.map(i => ({ item_id: parseInt(i.item_id), quantity_per_batch: parseFloat(i.quantity_per_batch) })),
      })),
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
          <ItemField
            items={items} value={form.output_item_id} tiers={['preprocessed', 'final']} placeholder="Select output"
            onChange={v => setForm(f => ({ ...f, output_item_id: v }))} onCreated={onItemCreated}
          />
        </div>
        <div>
          <label className={labelCls}>Yield per Batch{output ? ` (${output.unit_type})` : ''}</label>
          <input
            type="number" inputMode="decimal" step="any" min="0.001" placeholder="e.g. 20"
            value={form.items_per_batch} onChange={e => setForm(f => ({ ...f, items_per_batch: e.target.value }))}
            className={inputCls} required
          />
        </div>
      </div>
      <p className="-mt-3 text-xs text-gray-500">
        Recipes make preprocessed items (used in other recipes) or final goods. Not on the list yet? Pick “+ New item…” to add it here.
      </p>

      <div>
        <label className={labelCls}>About this recipe <span className="font-normal text-gray-400">(optional)</span></label>
        <AutoTextarea
          value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} rows={2}
          placeholder="What it is, shelf life, how to serve or store it, anything the cook should know first"
        />
      </div>

      <div className="space-y-3">
        <span className="block text-xs font-medium text-gray-600 uppercase tracking-wider">Sections</span>
        {form.sections.map((section, sIdx) => (
          <div key={sIdx} className="rounded-xl border border-white/70 bg-white/30 p-3 sm:p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400 w-5 shrink-0">{sIdx + 1}.</span>
              <input
                value={section.title} onChange={e => updateSection(sIdx, () => ({ title: e.target.value }))}
                placeholder={form.sections.length > 1 ? 'Section title, e.g. Filling' : 'Section title (optional), e.g. Filling'}
                className={`${inputCls} font-medium`}
              />
              <div className="flex items-center shrink-0 text-gray-400">
                <button type="button" disabled={sIdx === 0} onClick={() => moveSection(sIdx, -1)}
                  className="px-2 py-1 hover:text-gray-700 disabled:opacity-30" aria-label="Move section up">↑</button>
                <button type="button" disabled={sIdx === form.sections.length - 1} onClick={() => moveSection(sIdx, 1)}
                  className="px-2 py-1 hover:text-gray-700 disabled:opacity-30" aria-label="Move section down">↓</button>
                {form.sections.length > 1 && (
                  <button type="button" onClick={() => removeSection(sIdx)}
                    className="px-2 py-1 text-lg leading-none hover:text-red-500" aria-label="Remove section">×</button>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-gray-500">Ingredients per batch</span>
                <button type="button" onClick={() => updateSection(sIdx, s => ({ items: [...s.items, emptyIngredient()] }))}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold px-1 py-1">+ Ingredient</button>
              </div>
              {section.items.length === 0 && <p className="text-xs text-gray-400">No ingredients in this section (fine for steps like assembly or frying).</p>}
              <div className="space-y-2">
                {section.items.map((row, iIdx) => {
                  const item = items.find(i => i.id === Number(row.item_id))
                  return (
                    <div key={iIdx} className="flex gap-2 items-center">
                      <div className="flex-1 min-w-0">
                        <ItemField
                          items={items} value={row.item_id} tiers={['raw', 'preprocessed']} placeholder="Select ingredient"
                          exclude={output ? [output.id] : []}
                          onChange={v => updateIngredient(sIdx, iIdx, 'item_id', v)} onCreated={onItemCreated}
                        />
                      </div>
                      <input
                        type="number" inputMode="decimal" step="any" min="0" placeholder="0.00" value={row.quantity_per_batch}
                        onChange={e => updateIngredient(sIdx, iIdx, 'quantity_per_batch', e.target.value)}
                        className="w-20 sm:w-28 glass-input px-2 py-2 text-sm" required
                      />
                      <span className="w-8 sm:w-12 text-xs text-gray-500 truncate">{item?.unit_type}</span>
                      <button type="button" onClick={() => updateSection(sIdx, s => ({ items: s.items.filter((_, i) => i !== iIdx) }))}
                        className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none px-1" aria-label="Remove ingredient">×</button>
                    </div>
                  )
                })}
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-gray-500 mb-1.5">Steps <span className="font-normal text-gray-400">(one per line, numbered automatically)</span></span>
              <AutoTextarea
                value={section.instructions} onChange={v => updateSection(sIdx, () => ({ instructions: v }))} rows={3}
                placeholder={'Melt the butter over low heat.\nWhisk in the flour and cook 2 minutes.\nPour in the milk slowly, stirring until thick.'}
              />
              {section.instructions.trim() && (
                <p className="mt-1 text-[11px] text-gray-400">{section.instructions.split('\n').filter(l => l.trim()).length} steps</p>
              )}
            </div>
          </div>
        ))}
        <button type="button" onClick={() => setForm(f => ({ ...f, sections: [...f.sections, emptySection()] }))}
          className="w-full rounded-xl border border-dashed border-indigo-300 py-2.5 text-sm font-semibold text-indigo-600 hover:bg-white/40">
          + Add section
        </button>
      </div>

      <div>
        <label className={labelCls}>{recipe ? 'What changed?' : 'Note'} <span className="font-normal text-gray-400">(optional)</span></label>
        <input
          value={note} onChange={e => setNote(e.target.value)} className={inputCls}
          placeholder={recipe ? 'e.g. Less salt, bigger batch, clearer frying steps' : 'First version'}
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

// A recipe version written out like a document: description, then each section with its
// ingredients and numbered steps. An untitled section (recipes written before sections
// existed) reads as "Ingredients" and "Method".
function RecipeDocument({ doc }) {
  return (
    <article className="text-sm text-gray-700 space-y-4">
      <p className="text-xs text-gray-500">Makes {qty(doc.items_per_batch)} {doc.unit_type} {doc.output_name} per batch</p>
      {doc.description && <p className="whitespace-pre-line leading-relaxed">{doc.description}</p>}
      {doc.sections.map(s => {
        const steps = stepsOf(s.instructions)
        return (
          <section key={s.id} className="space-y-2">
            {s.title && <h4 className="text-base font-semibold text-gray-800 border-b border-white/60 pb-1">{s.title}</h4>}
            {s.items.length > 0 && (
              <div>
                {!s.title && <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Ingredients</h4>}
                <ul className="divide-y divide-white/50">
                  {s.items.map(i => (
                    <li key={i.id} className="flex justify-between gap-3 py-1">
                      <span>
                        {i.item_name}
                        {i.tier === 'preprocessed' && <span className="ml-2"><TierBadge tier={i.tier} short /></span>}
                      </span>
                      <span className="text-gray-600 whitespace-nowrap">{qty(i.quantity_per_batch)} {i.unit_type}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {steps.length > 0 && (
              <div>
                {!s.title && <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Method</h4>}
                <ol className="space-y-1.5">
                  {steps.map((step, n) => (
                    <li key={n} className="flex gap-2 leading-relaxed">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold flex items-center justify-center">{n + 1}</span>
                      <span className="pt-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        )
      })}
      {doc.sections.every(s => !s.instructions) && (
        <p className="text-xs text-gray-400 italic">No steps written yet. Use “New version” to add sections and instructions.</p>
      )}
    </article>
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

// Lines removed from `a` and added in `b` (longest common subsequence), for step changes
function lineDiff(a, b) {
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: 'removed', line: a[i++] })
    else out.push({ kind: 'added', line: b[j++] })
  }
  while (i < a.length) out.push({ kind: 'removed', line: a[i++] })
  while (j < b.length) out.push({ kind: 'added', line: b[j++] })
  return out
}

const sectionName = s => s.title || 'Untitled section'

// Sections keyed by title (the 2nd "Sauce" becomes "sauce#2"), so they can be matched up
// between versions even when moved
function keyedSections(sections) {
  const seen = new Map()
  return sections.map(s => {
    const base = (s.title || '').trim().toLowerCase()
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return [n > 1 ? `${base}#${n}` : base, s]
  })
}

// What changed from `older` to `newer`: output, yield, description, ingredient totals,
// sections and their steps
function versionChanges(older, newer) {
  const changes = []
  if (older.output_item_id !== newer.output_item_id) changes.push({ kind: 'changed', text: `Makes ${newer.output_item_name} (was ${older.output_item_name})` })
  if (older.items_per_batch !== newer.items_per_batch) {
    changes.push({ kind: 'changed', text: `Yield ${qty(older.items_per_batch)} → ${qty(newer.items_per_batch)} ${newer.output_unit_type}` })
  }
  if ((older.description || '') !== (newer.description || '')) {
    changes.push({ kind: !older.description ? 'added' : !newer.description ? 'removed' : 'changed', text: 'About this recipe' + (!older.description ? ' written' : !newer.description ? ' removed' : ' rewritten') })
  }

  // Ingredients over the whole recipe (an item may sit in several sections)
  const totals = v => v.items.reduce((m, i) => {
    const t = m.get(i.item_id) || { ...i, quantity_per_batch: 0 }
    return m.set(i.item_id, { ...t, quantity_per_batch: t.quantity_per_batch + i.quantity_per_batch })
  }, new Map())
  const before = totals(older)
  const after = totals(newer)
  for (const i of after.values()) {
    const was = before.get(i.item_id)
    if (!was) changes.push({ kind: 'added', text: `${i.item_name} ${qty(i.quantity_per_batch)} ${i.unit_type}` })
    else if (Math.abs(was.quantity_per_batch - i.quantity_per_batch) > 1e-9) {
      changes.push({ kind: 'changed', text: `${i.item_name} ${qty(was.quantity_per_batch)} → ${qty(i.quantity_per_batch)} ${i.unit_type}` })
    }
  }
  for (const i of before.values()) {
    if (!after.has(i.item_id)) changes.push({ kind: 'removed', text: `${i.item_name} ${qty(i.quantity_per_batch)} ${i.unit_type}` })
  }

  // Sections, matched by title, and the steps inside them
  const olderSections = new Map(keyedSections(older.sections))
  const newerKeyed = keyedSections(newer.sections)
  const matched = []
  for (const [key, s] of newerKeyed) {
    const was = olderSections.get(key)
    if (!was) {
      changes.push({ kind: 'added', text: `Section “${sectionName(s)}”${stepsOf(s.instructions).length ? ` with ${stepsOf(s.instructions).length} steps` : ''}` })
      continue
    }
    matched.push(key)
    for (const d of lineDiff(stepsOf(was.instructions), stepsOf(s.instructions))) {
      changes.push({ kind: d.kind, text: `${sectionName(s)}: ${d.line}`, step: true })
    }
  }
  for (const [key, s] of olderSections) {
    if (!newerKeyed.some(([k]) => k === key)) changes.push({ kind: 'removed', text: `Section “${sectionName(s)}”` })
  }
  const olderOrder = [...olderSections.keys()].filter(k => matched.includes(k))
  if (olderOrder.join('|') !== matched.join('|')) changes.push({ kind: 'changed', text: 'Sections reordered' })
  return changes
}

// [sign, colour, text style]
const CHANGE_STYLE = {
  added: ['+', 'text-emerald-700', ''],
  removed: ['−', 'text-red-600', 'line-through decoration-red-300'],
  changed: ['~', 'text-amber-700', ''],
}

// A version from /versions in the shape RecipeDocument reads
const versionDoc = v => ({
  items_per_batch: v.items_per_batch, unit_type: v.output_unit_type, output_name: v.output_item_name,
  description: v.description, sections: v.sections,
})

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
                <button onClick={() => setOpenId(o => o === v.id ? null : v.id)} className="text-indigo-500 hover:text-indigo-700 font-medium py-1">
                  {openId === v.id ? 'Hide' : 'Read'}
                </button>
                {!v.is_current && <button onClick={() => restore(v)} className="text-emerald-600 hover:text-emerald-800 font-medium py-1">Restore</button>}
              </div>
            </div>
            {v.note && <p className="mt-1 text-sm text-gray-700 italic">“{v.note}”</p>}
            {changes.length > 0 && (
              <ul className="mt-2 text-xs space-y-0.5">
                {changes.map((c, i) => (
                  <li key={i} className={`flex ${CHANGE_STYLE[c.kind][1]}`}>
                    <span className="inline-block w-3 shrink-0 font-bold">{CHANGE_STYLE[c.kind][0]}</span>
                    <span>{c.step && <span className="text-gray-400">step · </span>}<span className={CHANGE_STYLE[c.kind][2]}>{c.text}</span></span>
                  </li>
                ))}
              </ul>
            )}
            {openId === v.id && (
              <div className="mt-3 rounded-lg bg-white/40 p-3">
                <RecipeDocument doc={versionDoc(v)} />
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function RecipeDetail({ recipe, onRestored }) {
  const [tab, setTab] = useState('recipe')
  const [full, setFull] = useState(null)
  useEffect(() => { apiFetch(`/api/recipes/${recipe.id}`).then(r => r.json()).then(setFull) }, [recipe.id, recipe.current_version_id])
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'recipe', label: `Recipe v${recipe.version_no}` },
        { value: 'cost', label: 'Cost' },
        { value: 'history', label: 'History', count: recipe.version_count },
      ]} />
      {tab === 'recipe' && (full
        ? <RecipeDocument doc={{ ...full, output_name: full.output_item_name }} />
        : <p className="text-sm text-gray-400">Loading recipe...</p>)}
      {tab === 'cost' && <RecipeTree key={recipe.current_version_id} recipeId={recipe.id} />}
      {tab === 'history' && <VersionHistory recipeId={recipe.id} onRestored={onRestored} />}
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

  const addItem = item => setItems(prev => [...prev, item])

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
      <PageHeader title="Recipes" subtitle="Written recipes with sections and steps. Every change is kept as a version.">
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
            onItemCreated={addItem}
            onCancel={() => { setShowForm(false); setCopySource(null) }}
          />
        </div>
      )}

      {editingRecipe && (
        <div className="glass-card ring-1 ring-indigo-300/60 p-4 sm:p-6 mb-5">
          <SectionTitle className="mb-4 !text-indigo-600">
            New version of {editingRecipe.name} <span className="normal-case font-normal text-gray-500">(now on version {editingRecipe.version_no})</span>
          </SectionTitle>
          <RecipeForm items={items} recipe={editingRecipe} onSave={handleSave} onCancel={() => setEditingRecipe(null)} onItemCreated={addItem} />
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
