// Matching receipt lines to stock items.
//
// 1. Learned aliases: every saved receipt teaches the app "this receipt text = this item,
//    N item units per receipt unit" (or "this is an expense", or "skip this line").
// 2. Otherwise a fuzzy name match, flagged as a guess.
// Quantities convert through the pack size printed in the text when the units allow it:
// 2 × "TERIGU SEGITIGA 1KG" for an item kept in g = 2000 g.

export const normalize = text => String(text || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

// Known units, each as [dimension, size of one unit in the base unit (g or mL)]
const UNITS = {
  mg: ['mass', 0.001], g: ['mass', 1], gr: ['mass', 1], grm: ['mass', 1], gram: ['mass', 1], grams: ['mass', 1],
  kg: ['mass', 1000], kilo: ['mass', 1000], kgs: ['mass', 1000],
  ml: ['volume', 1], cc: ['volume', 1],
  l: ['volume', 1000], lt: ['volume', 1000], ltr: ['volume', 1000], liter: ['volume', 1000], litre: ['volume', 1000],
}

export const unitInfo = unit => UNITS[String(unit || '').toLowerCase()] || null

// Pack size printed in a description, e.g. "1KG" -> { dim: 'mass', base: 1000 }
export function packSize(text) {
  const re = /(\d+(?:[.,]\d+)?)\s*(mg|kgs?|kilo|grams?|grm|gr|g|ml|cc|ltr|lt|liter|litre|l)\b/gi
  let m
  let found = null
  while ((m = re.exec(String(text || '')))) {
    const [dim, factor] = UNITS[m[2].toLowerCase()]
    found = { dim, base: Number(m[1].replace(',', '.')) * factor }
  }
  return found // the last size wins: "SUSU 3X1L" style multipacks are rare, sizes at the end are common
}

// Item units per one receipt unit, from the pack size; null when it can't be worked out
export function sizeFactor(text, itemUnit) {
  const pack = packSize(text)
  const unit = unitInfo(itemUnit)
  if (!pack || !unit || pack.dim !== unit[0]) return null
  return pack.base / unit[1]
}

// Dice coefficient over character bigrams of the normalized strings
function bigrams(s) {
  const out = new Map()
  const t = ` ${s} `
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    out.set(g, (out.get(g) || 0) + 1)
  }
  return out
}

function dice(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  let overlap = 0
  let total = 0
  for (const [g, n] of A) { total += n; overlap += Math.min(n, B.get(g) || 0) }
  for (const n of B.values()) total += n
  return total ? (2 * overlap) / total : 0
}

// How well an item name fits a receipt description, 0..1. Every word of the item name
// appearing in the description counts most ("Terigu" in "TPG TERIGU SEGITIGA 1KG").
export function score(description, itemName) {
  const desc = normalize(description)
  const name = normalize(itemName)
  if (!desc || !name) return 0
  const descWords = new Set(desc.split(' '))
  const nameWords = name.split(' ').filter(w => w.length >= 2)
  const covered = nameWords.length
    ? nameWords.filter(w => descWords.has(w) || [...descWords].some(d => d.length >= 4 && (d.startsWith(w) || w.startsWith(d)))).length / nameWords.length
    : 0
  return Math.max(covered * 0.9, dice(desc, name))
}

export function bestItem(description, items, threshold = 0.5) {
  let best = null
  for (const item of items) {
    const s = score(description, item.name)
    if (s >= threshold && (!best || s > best.score)) best = { item, score: s }
  }
  return best
}

// Alias = { kind: 'item', item_id, factor } | { kind: 'expense', account_id } | { kind: 'skip' }
export const aliasKey = normalize

// Fill a parsed/extracted line's match: alias first, then the AI's suggestion, then fuzzy.
// `line` has description, quantity (as printed), amount, and optionally an AI suggestion
// (kind, item_id, item_quantity, account_id). Returns the review line.
export function resolveLine(line, { items, accounts, aliases }) {
  const base = {
    text: line.description,
    receipt_qty: line.quantity || 1,
    amount: line.amount != null ? String(Math.round(line.amount)) : '',
    kind: 'item', item_id: '', quantity: '', account_id: '', description: '',
    match: 'none', // alias | ai | guess | none
  }
  const qtyFor = (item, factor) => {
    const f = factor ?? sizeFactor(line.description, item.unit_type) ?? 1
    return String(round(base.receipt_qty * f))
  }

  const alias = aliases[aliasKey(line.description)]
  if (alias) {
    if (alias.kind === 'skip') return { ...base, kind: 'skip', match: 'alias' }
    if (alias.kind === 'expense' && accounts.some(a => a.id === alias.account_id)) {
      return { ...base, kind: 'expense', account_id: String(alias.account_id), description: line.description, match: 'alias' }
    }
    const item = items.find(i => i.id === alias.item_id)
    if (alias.kind === 'item' && item) {
      return { ...base, item_id: String(item.id), quantity: qtyFor(item, alias.factor), match: 'alias' }
    }
  }

  if (line.kind === 'expense' && accounts.some(a => a.id === line.account_id)) {
    return { ...base, kind: 'expense', account_id: String(line.account_id), description: line.description, match: 'ai' }
  }
  if (line.kind === 'item') {
    const item = items.find(i => i.id === line.item_id)
    if (item) {
      const quantity = line.item_quantity > 0 ? String(round(line.item_quantity)) : qtyFor(item)
      return { ...base, item_id: String(item.id), quantity, match: 'ai' }
    }
  }

  const guess = bestItem(line.description, items)
  if (guess) return { ...base, item_id: String(guess.item.id), quantity: qtyFor(guess.item), match: 'guess' }
  return { ...base, quantity: String(base.receipt_qty) }
}

// After a purchase is saved: remember how each line was matched
export function learn(aliases, lines) {
  const next = { ...aliases }
  for (const l of lines) {
    const key = aliasKey(l.text)
    if (!key) continue
    if (l.kind === 'skip') next[key] = { kind: 'skip', at: Date.now() }
    else if (l.kind === 'expense' && l.account_id) next[key] = { kind: 'expense', account_id: Number(l.account_id), at: Date.now() }
    else if (l.kind === 'item' && l.item_id && Number(l.quantity) > 0) {
      next[key] = { kind: 'item', item_id: Number(l.item_id), factor: round(Number(l.quantity) / (Number(l.receipt_qty) || 1)), at: Date.now() }
    }
  }
  return next
}

// Aliases as examples for Claude, newest first
export function aliasHints(aliases, items, accounts) {
  return Object.entries(aliases)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .map(([text, a]) => {
      if (a.kind === 'skip') return { text, target: 'skip (not a purchase line)' }
      if (a.kind === 'expense') {
        const acc = accounts.find(x => x.id === a.account_id)
        return acc && { text, target: `expense: ${acc.name} (account ${acc.id})` }
      }
      const item = items.find(x => x.id === a.item_id)
      return item && { text, target: `${item.name} (item ${item.id}), ${a.factor} ${item.unit_type} per receipt unit` }
    })
    .filter(Boolean)
}

export const round = n => Math.round(n * 1000) / 1000
