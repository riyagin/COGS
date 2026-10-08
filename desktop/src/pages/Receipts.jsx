// Receipts: drop in a stack of receipt photos, let OCR fill each one in as a purchase,
// check it against the photo, save. Saved lines teach the matcher for next time.
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../../frontend/src/lib/api'
import { rp, qty, unitRp, today } from '../../../frontend/src/lib/format'
import { Alert, MoneyInput, PageHeader, jsonOrThrow, inputCls, labelCls } from '../../../frontend/src/components/ui'
import { useMe } from '../../../frontend/src/auth/AuthGate'
import ItemInput from '../components/ItemInput'
import { MatchBadge, Segmented, Spinner, useImageUrl } from '../components/bits'
import { desktop, newKey, usePersisted } from '../lib/desktop'
import { bytesToBlob, prepareForOcr, prepareStored } from '../lib/image'
import { parseReceipt } from '../lib/receiptParse'
import { aliasHints, bestItem, learn, resolveLine, round, sizeFactor } from '../lib/matching'
import { DEFAULT_SETTINGS } from './Settings'

const PAYMENT_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'unpaid', label: 'Unpaid' },
]
const KIND_OPTIONS = [
  { value: 'item', label: 'Stock' },
  { value: 'expense', label: 'Expense' },
  { value: 'skip', label: 'Skip', title: 'Leave this line out of the purchase' },
]

const blankLine = () => ({
  key: newKey(), text: '', receipt_qty: 1, amount: '', kind: 'item',
  item_id: '', quantity: '', account_id: '', description: '', match: 'none',
})

const newDraft = ({ imageId = null, name, payment }) => ({
  id: newKey(),
  imageId,
  name,
  addedAt: Date.now(),
  status: imageId ? 'queued' : 'review', // queued | scanning | review | saving | saved | error
  engine: null,
  error: '',
  ocrText: '',
  receiptTotal: null,
  header: { date: today(), supplier: '', reference: '', note: '', payment },
  lines: imageId ? [] : [blankLine()],
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())

function lineProblem(l) {
  if (l.kind === 'skip') return null
  if (l.kind === 'item') {
    if (!l.item_id) return 'Choose an item'
    if (!(Number(l.quantity) > 0)) return 'Enter the quantity'
  } else if (!l.account_id) return 'Choose an expense type'
  if (!(Number(l.amount) > 0)) return 'Enter the amount'
  return null
}

const linesTotal = lines => lines.filter(l => l.kind !== 'skip').reduce((s, l) => s + (Number(l.amount) || 0), 0)

export default function Receipts() {
  const me = useMe()
  const readOnly = me.role === 'viewer'
  const [settings, , settingsReady] = usePersisted('settings', DEFAULT_SETTINGS)
  const [aliases, setAliases] = usePersisted('aliases', {})
  const [drafts, setDrafts, draftsReady] = usePersisted('receipts', [])
  const [selectedId, setSelectedId] = useState(null)
  const [notice, setNotice] = useState({ kind: 'success', text: '' })
  const [dragging, setDragging] = useState(false)
  const [tick, setTick] = useState(0)
  const [ref, setRef] = useState({ items: [], accounts: [], suppliers: [], purchases: [], loaded: false, error: '' })
  const scanning = useRef(false)
  const fileInput = useRef(null)

  const { items, accounts, suppliers, purchases } = ref

  async function loadReference() {
    try {
      const [itemList, accountList, supplierList, purchaseList] = await Promise.all([
        apiFetch('/api/items').then(jsonOrThrow),
        apiFetch('/api/accounting/accounts').then(jsonOrThrow),
        apiFetch('/api/purchases/suppliers').then(jsonOrThrow),
        apiFetch('/api/purchases').then(jsonOrThrow),
      ])
      setRef({
        items: itemList,
        accounts: accountList.filter(a => a.active && (['expense', 'cogs'].includes(a.type) || (a.type === 'asset' && !a.system_key))),
        suppliers: supplierList,
        purchases: purchaseList.map(({ id, date, total, supplier, reference }) => ({ id, date, total, supplier, reference })),
        loaded: true,
        error: '',
      })
    } catch (err) {
      setRef(r => ({ ...r, error: err.message || 'Could not reach the server' }))
    }
  }
  useEffect(() => { loadReference() }, [])

  const updateDraft = (id, patch) => setDrafts(ds => ds.map(d => d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d))

  // Scans interrupted by closing the app start over
  useEffect(() => {
    if (draftsReady) setDrafts(ds => ds.map(d => d.status === 'scanning' ? { ...d, status: 'queued' } : d.status === 'saving' ? { ...d, status: 'review' } : d))
  }, [draftsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Pick something to show
  useEffect(() => {
    if (!drafts.some(d => d.id === selectedId)) {
      setSelectedId((drafts.find(d => d.status !== 'saved') || drafts[0])?.id ?? null)
    }
  }, [drafts, selectedId])

  async function scan(draft) {
    const engine = draft.engine || settings.engine
    let result
    if (engine === 'claude') {
      result = await desktop.ocrClaude({
        imageId: draft.imageId,
        items: items.map(({ id, name, unit_type }) => ({ id, name, unit_type })),
        accounts: accounts.map(({ id, name }) => ({ id, name })),
        aliases: aliasHints(aliases, items, accounts),
        today: today(),
      })
    } else {
      const ocrImage = await prepareForOcr(bytesToBlob(await desktop.readImage(draft.imageId)))
      const { text } = await desktop.ocrLocal(ocrImage)
      result = { ...parseReceipt(text), text }
    }

    const known = result.supplier && bestItem(result.supplier, suppliers.map(name => ({ name })), 0.6)
    const supplier = known ? known.item.name : result.supplier ? titleCase(result.supplier) : ''
    const lines = (result.lines || []).filter(l => l.amount > 0).map(l => ({ key: newKey(), ...resolveLine(l, { items, accounts, aliases }) }))
    return {
      engine,
      ocrText: result.text || '',
      receiptTotal: result.total ?? null,
      header: {
        ...draft.header,
        date: ISO_DATE.test(result.date || '') ? result.date : draft.header.date,
        supplier: supplier || draft.header.supplier,
        reference: result.reference || draft.header.reference,
      },
      lines: lines.length ? lines : [blankLine()],
    }
  }

  // Work through queued photos one at a time
  useEffect(() => {
    if (!draftsReady || !settingsReady || !ref.loaded || scanning.current) return
    const next = drafts.find(d => d.status === 'queued')
    if (!next) return
    scanning.current = true
    updateDraft(next.id, { status: 'scanning', error: '' })
    scan(next)
      .then(patch => updateDraft(next.id, { ...patch, status: 'review' }))
      .catch(err => updateDraft(next.id, { status: 'error', error: cleanError(err) }))
      .finally(() => { scanning.current = false; setTick(t => t + 1) })
  }, [drafts, draftsReady, settingsReady, ref.loaded, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(fileList) {
    const files = [...fileList]
    const added = []
    const skipped = []
    for (const file of files) {
      try {
        const imageId = await desktop.saveImage(await prepareStored(file))
        if (drafts.some(d => d.imageId === imageId) || added.some(d => d.imageId === imageId)) {
          skipped.push(`${file.name} is already in the list`)
          continue
        }
        added.push(newDraft({ imageId, name: file.name, payment: settings.payment }))
      } catch {
        skipped.push(`${file.name} can't be opened (use JPG, PNG or WebP)`)
      }
    }
    if (added.length) {
      setDrafts(ds => [...ds, ...added])
      setSelectedId(id => (drafts.some(d => d.id === id && d.status !== 'saved') ? id : added[0].id))
    }
    setNotice(skipped.length
      ? { kind: 'error', text: `Added ${added.length}. Skipped: ${skipped.join('; ')}` }
      : { kind: 'success', text: added.length ? `Added ${added.length} receipt${added.length === 1 ? '' : 's'}; reading them now.` : '' })
  }

  function addBlank() {
    const d = newDraft({ name: 'Manual entry', payment: settings.payment })
    setDrafts(ds => [...ds, d])
    setSelectedId(d.id)
  }

  async function removeDraft(draft) {
    if (draft.status !== 'saved' && draft.lines.some(l => l.item_id || l.amount) && !confirm('Discard this receipt? Nothing has been saved from it.')) return
    setDrafts(ds => ds.filter(d => d.id !== draft.id))
    if (draft.imageId && !drafts.some(d => d.id !== draft.id && d.imageId === draft.imageId)) await desktop.deleteImage(draft.imageId)
  }

  async function clearSaved() {
    const saved = drafts.filter(d => d.status === 'saved')
    setDrafts(ds => ds.filter(d => d.status !== 'saved'))
    await Promise.all(saved.filter(d => d.imageId).map(d => desktop.deleteImage(d.imageId)))
  }

  async function save(draft) {
    const lines = draft.lines.filter(l => l.kind !== 'skip')
    const lineIndex = draft.lines.findIndex(lineProblem)
    const problem = !ISO_DATE.test(draft.header.date) ? 'Set the purchase date'
      : !lines.length ? 'Add at least one line'
      : lineIndex >= 0 ? `Line ${lineIndex + 1}${draft.lines[lineIndex].text ? ` (${draft.lines[lineIndex].text})` : ''}: ${lineProblem(draft.lines[lineIndex])}`
      : null
    if (problem) return setNotice({ kind: 'error', text: problem })

    updateDraft(draft.id, { status: 'saving' })
    try {
      const saved = await jsonOrThrow(await apiFetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft.header,
          lines: lines.map(l => l.kind === 'item'
            ? { item_id: Number(l.item_id), quantity: Number(l.quantity), amount: Number(l.amount), description: l.text || null }
            : { account_id: Number(l.account_id), description: l.description || l.text, amount: Number(l.amount) }),
        }),
      }))
      updateDraft(draft.id, { status: 'saved', purchaseId: saved.id, savedTotal: saved.total, error: '' })
      setAliases(a => learn(a, draft.lines.filter(l => l.text)))
      setNotice({ kind: 'success', text: `Saved ${rp(saved.total)}${saved.supplier ? ` from ${saved.supplier}` : ''}${saved.paid_date ? '' : ' as unpaid'}.` })
      const next = drafts.find(d => d.id !== draft.id && ['review', 'queued', 'scanning', 'error'].includes(d.status))
      if (next) setSelectedId(next.id)
      loadReference() // new last prices, supplier list and purchases for the duplicate check
    } catch (err) {
      updateDraft(draft.id, { status: 'review' })
      setNotice({ kind: 'error', text: cleanError(err) })
    }
  }

  const selected = drafts.find(d => d.id === selectedId) || null
  const counts = useMemo(() => ({
    waiting: drafts.filter(d => ['queued', 'scanning'].includes(d.status)).length,
    review: drafts.filter(d => ['review', 'error'].includes(d.status)).length,
    saved: drafts.filter(d => d.status === 'saved').length,
  }), [drafts])

  // Ctrl+Enter saves the receipt on screen
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selected?.status === 'review' && !readOnly) {
        e.preventDefault()
        save(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      className="h-full flex flex-col"
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
    >
      <PageHeader title="Receipts" subtitle="Drop receipt photos here. Each one becomes a purchase after you check it.">
        <div className="flex items-center gap-2">
          <button type="button" onClick={addBlank} className="bg-white/40 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-white/60">
            Manual entry
          </button>
          <button type="button" onClick={() => fileInput.current.click()} className="btn-primary px-4 py-2">Add photos</button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
        </div>
      </PageHeader>

      {readOnly && <Alert>Your account is read-only, so receipts can be read but not saved.</Alert>}
      <Alert onClose={() => setRef(r => ({ ...r, error: '' }))}>{ref.error && `Could not load items from the server: ${ref.error}`}</Alert>
      <Alert kind={notice.kind} onClose={() => setNotice({ ...notice, text: '' })}>{notice.text}</Alert>

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Queue */}
        <aside className="glass-card w-56 shrink-0 flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-white/50 text-xs text-gray-500 flex flex-wrap gap-x-3">
            <span>{counts.review} to check</span>
            {counts.waiting > 0 && <span className="text-indigo-600">{counts.waiting} reading</span>}
            <span>{counts.saved} saved</span>
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-white/50">
            {drafts.length === 0 && <li className="p-4 text-sm text-gray-400">No receipts yet. Drop photos anywhere on this page.</li>}
            {drafts.map(d => (
              <li key={d.id}>
                <button type="button" onClick={() => setSelectedId(d.id)}
                  className={`w-full text-left px-3 py-2.5 transition-colors ${d.id === selectedId ? 'bg-indigo-50/80' : 'hover:bg-white/40'}`}>
                  <div className="flex items-center gap-2">
                    <StatusDot status={d.status} />
                    <span className={`text-sm truncate ${d.status === 'saved' ? 'text-gray-400' : 'text-gray-800 font-medium'}`}>
                      {d.header.supplier || d.name}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 pl-4 truncate">
                    {d.status === 'saved' ? `Saved · ${rp(d.savedTotal)}`
                      : d.status === 'error' ? 'Could not read'
                      : ['queued', 'scanning'].includes(d.status) ? (d.status === 'scanning' ? 'Reading…' : 'Waiting')
                      : `${d.header.date} · ${rp(linesTotal(d.lines))}`}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          {counts.saved > 0 && (
            <button type="button" onClick={clearSaved} className="px-3 py-2 border-t border-white/50 text-xs font-medium text-gray-500 hover:text-gray-800">
              Clear {counts.saved} saved
            </button>
          )}
        </aside>

        {selected ? (
          <ReceiptEditor
            key={selected.id}
            draft={selected}
            ctx={{ items, accounts, suppliers, purchases }}
            readOnly={readOnly}
            engine={settings.engine}
            onChange={patch => updateDraft(selected.id, patch)}
            onSave={() => save(selected)}
            onRemove={() => removeDraft(selected)}
          />
        ) : (
          <div className="glass-card flex-1 flex items-center justify-center text-center p-8">
            <div>
              <p className="text-gray-600 font-medium">Drop receipt photos here</p>
              <p className="text-sm text-gray-400 mt-1">or use Add photos. Several at once is fine.</p>
            </div>
          </div>
        )}
      </div>

      {dragging && (
        <div className="fixed inset-0 z-50 bg-indigo-500/10 border-4 border-dashed border-indigo-400 rounded-3xl m-3 pointer-events-none flex items-center justify-center">
          <p className="glass-panel rounded-2xl px-6 py-4 text-indigo-700 font-semibold">Drop to add receipts</p>
        </div>
      )}
    </div>
  )
}

const cleanError = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function StatusDot({ status }) {
  if (status === 'scanning') return <Spinner className="w-2.5 h-2.5 shrink-0" />
  const color = {
    queued: 'bg-gray-300', review: 'bg-amber-400', saving: 'bg-indigo-400', saved: 'bg-emerald-500', error: 'bg-red-500',
  }[status] || 'bg-gray-300'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
}

function ReceiptEditor({ draft, ctx, readOnly, engine, onChange, onSave, onRemove }) {
  const { items, accounts, suppliers, purchases } = ctx
  const imageUrl = useImageUrl(draft.imageId)
  const [zoom, setZoom] = useState(100)
  const [busy, setBusy] = useState(false)
  const editable = draft.status === 'review' && !readOnly
  const saved = draft.status === 'saved'

  const setHeader = patch => onChange(d => ({ header: { ...d.header, ...patch } }))
  const setLines = fn => onChange(d => ({ lines: fn(d.lines) }))
  const setLine = (key, patch) => setLines(lines => lines.map(l => {
    if (l.key !== key) return l
    const next = { ...l, ...patch }
    // A newly chosen item gets its quantity from the pack size, unless the user typed one
    if ('item_id' in patch && patch.item_id !== l.item_id) {
      next.match = 'none'
      const item = items.find(i => i.id === Number(patch.item_id))
      if (item && !l.qty_manual) next.quantity = String(round((Number(l.receipt_qty) || 1) * (sizeFactor(l.text, item.unit_type) ?? 1)))
    }
    if ('account_id' in patch) next.match = 'none'
    return next
  }))

  const total = linesTotal(draft.lines)
  const receiptTotal = draft.receiptTotal
  const diff = receiptTotal != null && receiptTotal !== '' ? Number(receiptTotal) - total : 0
  const duplicate = purchases.find(p =>
    (draft.header.reference && p.reference && p.reference.toLowerCase() === draft.header.reference.toLowerCase())
    || (p.date === draft.header.date && total > 0 && Math.abs(p.total - total) < 1))

  // Spread the gap to the printed total (receipt-wide discount, tax, rounding) over the lines
  function spread() {
    const live = draft.lines.filter(l => l.kind !== 'skip' && Number(l.amount) > 0)
    if (!live.length || !total) return
    let left = diff
    const updated = new Map()
    live.forEach((l, i) => {
      const share = i === live.length - 1 ? left : Math.round((diff * Number(l.amount)) / total)
      left -= share
      updated.set(l.key, Number(l.amount) + share)
    })
    if ([...updated.values()].some(v => v <= 0)) return alert('The difference is bigger than the lines; check the amounts instead.')
    setLines(lines => lines.map(l => updated.has(l.key) ? { ...l, amount: String(updated.get(l.key)) } : l))
  }

  async function rotate() {
    setBusy(true)
    try {
      const bytes = await desktop.readImage(draft.imageId)
      const imageId = await desktop.saveImage(await prepareStored(bytesToBlob(bytes), 1))
      await desktop.deleteImage(draft.imageId)
      onChange({ imageId })
    } finally {
      setBusy(false)
    }
  }

  function rescan(withEngine) {
    if (draft.status === 'review' && draft.lines.some(l => l.item_id || l.amount) && !confirm('Read the photo again? Your changes to this receipt are replaced.')) return
    onChange({ status: 'queued', engine: withEngine, error: '' })
  }

  return (
    <div className="flex-1 min-w-0 flex gap-4">
      {/* Photo */}
      {draft.imageId && (
        <section className="glass-card w-[38%] min-w-[260px] flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-white/50 flex items-center gap-2 text-xs">
            <span className="truncate text-gray-500 flex-1" title={draft.name}>{draft.name}</span>
            <button type="button" onClick={() => setZoom(z => Math.max(50, z - 25))} className="px-1.5 text-gray-600 hover:text-gray-900" aria-label="Zoom out">−</button>
            <span className="text-gray-500 w-9 text-center">{zoom}%</span>
            <button type="button" onClick={() => setZoom(z => Math.min(400, z + 25))} className="px-1.5 text-gray-600 hover:text-gray-900" aria-label="Zoom in">+</button>
            {!saved && <button type="button" onClick={rotate} disabled={busy} className="font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50">Rotate</button>}
          </div>
          <div className="flex-1 overflow-auto bg-white/30">
            {imageUrl && <img src={imageUrl} alt="Receipt" style={{ width: `${zoom}%` }} className="max-w-none mx-auto" />}
          </div>
        </section>
      )}

      {/* Purchase */}
      <section className="glass-card flex-1 min-w-0 flex flex-col overflow-hidden">
        {['queued', 'scanning'].includes(draft.status) ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-500">
            {draft.status === 'scanning' ? <Spinner className="w-8 h-8" /> : null}
            <p className="text-sm">{draft.status === 'scanning' ? `Reading the receipt${(draft.engine || engine) === 'claude' ? ' with Claude' : ''}…` : 'Waiting its turn…'}</p>
            <p className="text-xs text-gray-400 max-w-xs text-center">The first local scan downloads the OCR language files (about 15 MB) once.</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {draft.status === 'error' && (
                <div className="text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">
                  Could not read this receipt: {draft.error}
                  <div className="mt-2 flex gap-3">
                    <button type="button" onClick={() => rescan(draft.engine || engine)} className="font-semibold underline">Try again</button>
                    <button type="button" onClick={() => onChange({ status: 'review', lines: draft.lines.length ? draft.lines : [blankLine()] })} className="font-semibold underline">Type it in instead</button>
                  </div>
                </div>
              )}
              {saved && (
                <div className="text-sm text-emerald-700 bg-emerald-50/70 border border-emerald-200/70 px-3 py-2 rounded-lg">
                  Saved as purchase #{draft.purchaseId} ({rp(draft.savedTotal)}). To change it, delete it on the Purchasing page of the web app and enter it again.
                </div>
              )}
              {duplicate && !saved && (
                <div className="text-sm text-amber-800 bg-amber-50/80 border border-amber-200/80 px-3 py-2 rounded-lg">
                  Possible duplicate: a purchase of {rp(duplicate.total)} on {duplicate.date}{duplicate.supplier ? ` from ${duplicate.supplier}` : ''}{duplicate.reference ? ` (#${duplicate.reference})` : ''} is already recorded.
                </div>
              )}

              <fieldset disabled={!editable} className="space-y-4">
                <div className="grid grid-cols-[9.5rem_1fr_9rem] gap-3">
                  <div>
                    <label className={labelCls}>Date</label>
                    <input type="date" value={draft.header.date} onChange={e => setHeader({ date: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Supplier</label>
                    <input list="desktop-suppliers" value={draft.header.supplier} onChange={e => setHeader({ supplier: e.target.value })} className={inputCls} placeholder="Shop name" />
                    <datalist id="desktop-suppliers">{suppliers.map(s => <option key={s} value={s} />)}</datalist>
                  </div>
                  <div>
                    <label className={labelCls}>Receipt no.</label>
                    <input value={draft.header.reference} onChange={e => setHeader({ reference: e.target.value })} className={inputCls} placeholder="optional" />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">Lines</span>
                    <span className="text-xs text-gray-400">Qty is in the item’s unit; packs convert automatically (2 × 1KG = 2000 g)</span>
                  </div>
                  <div className="space-y-2">
                    {draft.lines.map(line => (
                      <LineEditor key={line.key} line={line} items={items} accounts={accounts}
                        onChange={patch => setLine(line.key, patch)}
                        onRemove={() => setLines(lines => lines.filter(l => l.key !== line.key))} />
                    ))}
                  </div>
                  {editable && (
                    <button type="button" onClick={() => setLines(lines => [...lines, blankLine()])}
                      className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 font-semibold">+ Add line</button>
                  )}
                </div>

                <div>
                  <label className={labelCls}>Note</label>
                  <input value={draft.header.note} onChange={e => setHeader({ note: e.target.value })} className={inputCls} placeholder="optional" />
                </div>
              </fieldset>

              {draft.ocrText && (
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer select-none">Text the scanner read</summary>
                  <pre className="mt-2 p-3 rounded-lg bg-white/50 whitespace-pre-wrap font-mono text-[11px] text-gray-700">{draft.ocrText}</pre>
                </details>
              )}
            </div>

            {/* Totals and actions */}
            <div className="border-t border-white/50 p-4 space-y-3 bg-white/20">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <span className="block text-xs text-gray-500">Lines total</span>
                  <span className="text-lg font-bold text-gray-800">{rp(total)}</span>
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Printed total</label>
                  <MoneyInput disabled={!editable} value={receiptTotal ?? ''} placeholder="from receipt"
                    onChange={v => onChange({ receiptTotal: v === '' ? null : v })}
                    className="glass-input px-2 py-1 text-sm w-32" />
                </div>
                {Math.abs(diff) >= 1 && (
                  <div className="text-xs">
                    <p className="text-amber-700 font-medium">Differs by {rp(Math.abs(diff))} ({diff > 0 ? 'lines are short' : 'lines are over'})</p>
                    {editable && <button type="button" onClick={spread} className="font-semibold text-indigo-600 hover:text-indigo-800" title="For tax, rounding or a receipt-wide discount">Spread it over the lines</button>}
                  </div>
                )}
                <div className="ml-auto">
                  <span className="block text-xs text-gray-500 mb-1">Paid with</span>
                  <fieldset disabled={!editable}>
                    <Segmented options={PAYMENT_OPTIONS} value={draft.header.payment} onChange={payment => setHeader({ payment })} />
                  </fieldset>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={onRemove} className="text-xs font-medium text-red-400 hover:text-red-600">
                  {saved ? 'Remove from list' : 'Discard'}
                </button>
                {draft.imageId && !saved && (
                  <>
                    <button type="button" onClick={() => rescan('local')} className="text-xs font-medium text-gray-500 hover:text-gray-800">Read again</button>
                    <button type="button" onClick={() => rescan('claude')} className="text-xs font-medium text-violet-600 hover:text-violet-800">Read with Claude</button>
                  </>
                )}
                {!saved && (
                  <button type="button" onClick={onSave} disabled={!editable}
                    className="btn-primary px-6 py-2.5 ml-auto" title="Ctrl+Enter">
                    {draft.status === 'saving' ? 'Saving…' : 'Save purchase'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function LineEditor({ line, items, accounts, onChange, onRemove }) {
  const item = items.find(i => i.id === Number(line.item_id))
  const q = Number(line.quantity)
  const amount = Number(line.amount)
  const unitPrice = item && q > 0 && amount > 0 ? amount / q : null
  const last = item?.last_unit_price ?? null
  const change = last && unitPrice ? (unitPrice - last) / last : null
  const factor = item && Number(line.receipt_qty) > 0 && q > 0 ? q / Number(line.receipt_qty) : null
  const problem = lineProblem(line)
  const skipped = line.kind === 'skip'

  return (
    <div className={`rounded-xl border p-2.5 ${skipped ? 'border-white/40 bg-white/10 opacity-60' : 'border-white/60 bg-white/30'}`}>
      <div className="flex items-center gap-2">
        <input value={line.text} onChange={e => onChange({ text: e.target.value })} placeholder="Receipt text"
          className="flex-1 min-w-0 bg-transparent text-xs text-gray-500 font-mono focus:outline-none focus:text-gray-800"
          title="Text as printed on the receipt. The app remembers how you matched it." />
        <MatchBadge match={line.match} />
        <Segmented size="sm" options={KIND_OPTIONS} value={line.kind} onChange={kind => onChange({ kind })} />
        <button type="button" onClick={onRemove} className="text-gray-400 hover:text-red-500 px-1 leading-none" aria-label="Remove line">×</button>
      </div>
      {!skipped && (
        <div className="mt-2 grid grid-cols-[1fr_8.5rem_9rem] gap-2">
          {line.kind === 'item' ? (
            <ItemInput items={items} value={line.item_id} onChange={item_id => onChange({ item_id })} />
          ) : (
            <select value={line.account_id} onChange={e => onChange({ account_id: e.target.value })}
              className={`glass-input px-2 py-1.5 text-sm ${!line.account_id ? '!border-red-300' : ''}`}>
              <option value="">Expense type</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {line.kind === 'item' ? (
            <div className="relative">
              <input type="number" step="any" min="0" value={line.quantity} placeholder="Qty"
                onChange={e => onChange({ quantity: e.target.value, qty_manual: true })}
                className={`w-full glass-input px-2 py-1.5 text-sm pr-12 ${!(q > 0) ? '!border-red-300' : ''}`} />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{item?.unit_type}</span>
            </div>
          ) : (
            <input value={line.description} onChange={e => onChange({ description: e.target.value })} placeholder="What for"
              className="glass-input px-2 py-1.5 text-sm" />
          )}
          <MoneyInput value={line.amount} placeholder="Total Rp"
            onChange={v => onChange({ amount: v })}
            className={`glass-input px-2 py-1.5 text-sm text-right ${!(amount > 0) ? '!border-red-300' : ''}`} />
        </div>
      )}
      {!skipped && (
        <p className="mt-1 text-[11px] text-gray-500 flex flex-wrap gap-x-2">
          {problem && <span className="text-red-500">{problem}</span>}
          {line.kind === 'item' && factor && factor !== 1 && (
            <span>{qty(line.receipt_qty)} × {qty(factor)} {item.unit_type}</span>
          )}
          {unitPrice && <span>{unitRp(unitPrice)}/{item.unit_type}</span>}
          {last != null && <span>last {unitRp(last)}/{item.unit_type}</span>}
          {change != null && Math.abs(change) >= 0.05 && (
            <span className={`font-medium ${Math.abs(change) >= 0.5 ? 'text-red-600' : change > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {change > 0 ? '▲' : '▼'} {Math.abs(change * 100).toFixed(0)}% vs last{Math.abs(change) >= 0.5 ? ', check qty and amount' : ''}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
