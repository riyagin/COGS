// Turns OCR text of an Indonesian shop receipt into { supplier, date, reference, total, lines }.
// Heuristic: works on the usual layouts, and everything it produces is reviewed by a person.
//
//   TEPUNG TERIGU SEGITIGA 1KG   2 x 15.000   30.000     name, qty x price, amount
//   SUSU UHT 1L                                          name on one line ...
//     3 @ 12.500           37.500                       ... numbers on the next
//   GULA PASIR 1KG               16.000                 qty 1
//   DISC                         -2.000                 discount for the line above

const FOOTER = /\b(sub\s*-?\s*total|total|grand|tunai|cash|kembali(an)?|change|bayar|dibayar|payment|debit|kredit|credit|card|kartu|edc|qris|ovo|gopay|dana|ppn|pajak|tax|dpp|service|pembulatan|rounding|npwp|telp|tel|phone|hp|kasir|cashier|terima\s*kasih|thank|member|poin|points?|saldo|jumlah\s*item|total\s*item|items?\s*:|harga\s*jual)\b/i
const TOTAL = /\b(grand\s*total|total\s*(belanja|bayar|harga|akhir)?|jumlah\s*(bayar|total)?|tagihan)\b/i
const SUBTOTAL = /\bsub\s*-?\s*total\b/i
const DISCOUNT = /\b(disc|diskon|discount|potongan|pot|hemat|promo|voucher)\b/i
const ADDRESS = /\b(jl|jln|jalan|ruko|blok|kec|kel|kota|kab|rt|rw|no\.?)\b/i

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, ags: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 }

// "15.000" "15,000" "Rp15.000" "15.000,00" "-2.000" "(2.000)" "1,5" "0.250" → number; else null.
// OCR often reads 0 as O inside numbers.
export function parseNumber(token) {
  let s = String(token).trim()
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1) }
  s = s.replace(/^rp\.?\s*/i, '')
  if (!/\d/.test(s)) return null
  s = s.replace(/[Oo]/g, '0')
  if (!/^\d[\d.,]*$/.test(s)) return null

  let value
  // Thousands grouped with . or , and optional 1–2 decimals: 15.000 / 1.250.000 / 15.000,00
  const grouped = /^(\d{1,3}(?:[.,]\d{3})+)(?:[.,](\d{1,2}))?$/.exec(s)
  if (grouped && !/^0[.,]/.test(s)) {
    value = Number(grouped[1].replace(/[.,]/g, '')) + (grouped[2] ? Number(`0.${grouped[2]}`) : 0)
  } else if (/^\d+(?:[.,]\d+)?$/.test(s)) {
    value = Number(s.replace(',', '.'))
  } else {
    return null
  }
  return negative ? -value : value
}

// Tokens that may sit in the numbers column: numbers, "x", "@", "*", and quantity units
const isConnector = t => /^([x×]{1,2}|@|\*|=|pcs?|pc|bh|buah|btl|bks|pak|pack|unit|ea|qty)$/i.test(t)

// Split a line into the product name and the trailing numbers column
function splitLine(line) {
  const tokens = line.trim().split(/\s+/)
  let i = tokens.length
  while (i > 0) {
    const t = tokens[i - 1]
    // "2x" / "x2" glued to the number
    if (parseNumber(t) !== null || isConnector(t) || /^\d+x$/i.test(t) || /^x\d+$/i.test(t)) i--
    else break
  }
  const tail = tokens.slice(i)
  const numbers = []
  let marker = -1 // index in `numbers` of the first number after an x / @
  for (const t of tail) {
    if (/^([x×]{1,2}|@|\*)$/i.test(t)) { marker = numbers.length; continue }
    const glued = /^(\d+)x$/i.exec(t) || /^x(\d+)$/i.exec(t)
    if (glued) {
      if (/^x/i.test(t)) { marker = numbers.length; numbers.push(Number(glued[1])) } else { numbers.push(Number(glued[1])); marker = numbers.length }
      continue
    }
    const n = parseNumber(t)
    if (n !== null) numbers.push(n)
  }
  return { name: tokens.slice(0, i).join(' '), numbers, marker }
}

const close = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01)

const MAX_QTY = 100 // a bigger "quantity" is more likely part of the name (SAKURA MAYO 1000)

// qty / unit price / amount from the numbers column. `extra` is a number that turned out to
// belong to the product name.
function readNumbers(numbers, marker) {
  const amount = numbers[numbers.length - 1]
  if (numbers.length === 1) return { quantity: 1, unit_price: amount, amount }

  if (numbers.length >= 3) {
    // [qty, price, amount] (extra numbers in front are usually item codes)
    const [a, b] = numbers.slice(-3, -1)
    const [q, p] = a <= b ? [a, b] : [b, a]
    if (close(q * p, amount)) return { quantity: q, unit_price: p, amount }
    return { quantity: a, unit_price: b, amount }
  }

  // Two numbers: "qty x price" (no line total), "qty amount" or "price amount"
  const [a] = numbers
  if (marker === 1 && a > 0 && a <= MAX_QTY) {
    return { quantity: a, unit_price: amount, amount: a * amount }
  }
  if (a > 0 && a <= MAX_QTY && !close(a, amount)) {
    return { quantity: a, unit_price: amount / a, amount }
  }
  if (a > 0) {
    const q = Math.round(amount / a)
    if (q >= 1 && q <= MAX_QTY && close(q * a, amount)) return { quantity: q, unit_price: a, amount }
  }
  return { quantity: 1, unit_price: amount, amount, extra: a }
}

export function parseDate(text) {
  const valid = (y, m, d) => {
    if (y < 100) y += 2000
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  let m = /\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/.exec(text)
  if (m) { const r = valid(+m[1], +m[2], +m[3]); if (r) return r }
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(text)
  if (m) { const r = valid(+m[3], +m[2], +m[1]); if (r) return r }
  m = /\b(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{2,4})\b/i.exec(text)
  if (m && MONTHS[m[2].toLowerCase()]) { const r = valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); if (r) return r }
  return null
}

function parseReference(text) {
  const m = /\b(?:no\.?\s*(?:nota|struk|faktur|invoice|transaksi|trx)?|nota|invoice|inv|faktur|struk|trx|transaksi|receipt|bill)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/.]{3,})/i.exec(text)
  return m ? m[1] : null
}

const letterCount = s => (s.match(/[a-z]/gi) || []).length

export function parseReceipt(text) {
  const rawLines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim())

  const lines = []
  let total = null
  let subtotal = null
  let pendingName = null
  let firstItemIndex = -1

  rawLines.forEach((raw, index) => {
    const line = raw.trim()
    const { name, numbers, marker } = splitLine(line)
    const last = numbers[numbers.length - 1]

    if (DISCOUNT.test(line) && numbers.length) {
      // Applies to the line above it
      const prev = lines[lines.length - 1]
      if (prev && firstItemIndex >= 0) prev.amount = Math.max(0, prev.amount - Math.abs(last))
      pendingName = null
      return
    }
    if (FOOTER.test(line)) {
      if (numbers.length) {
        if (SUBTOTAL.test(line)) subtotal ??= Math.abs(last)
        else if (TOTAL.test(line) && total === null) total = Math.abs(last)
      }
      pendingName = null
      return
    }

    // A "name" without real words is OCR noise ("2 Xx 15.000"); the name was on the line above
    const label = name && (letterCount(name) >= 3 || !pendingName) ? name : pendingName
    if (!numbers.length || last <= 0) {
      // A name on its own line: the numbers follow on the next one
      pendingName = letterCount(line) >= 3 ? line : null
      return
    }
    if (!label || letterCount(label) < 2) { pendingName = null; return }
    // Lines with just a small number are usually codes or dates, not purchases
    if (last < 100 && numbers.length === 1) { pendingName = null; return }

    if (firstItemIndex < 0) firstItemIndex = index
    const { extra, ...values } = readNumbers(numbers, marker)
    lines.push({ description: extra != null ? `${label} ${extra}` : label, ...values })
    pendingName = null
  })

  // Shop name: the first lettered line at the top that isn't an address, date or phone
  const header = rawLines.slice(0, firstItemIndex >= 0 ? Math.min(firstItemIndex, 6) : 6)
  const supplier = header.map(l => l.trim()).find(l =>
    letterCount(l) >= 3 && letterCount(l) / l.replace(/\s/g, '').length > 0.6 && !ADDRESS.test(l) && !FOOTER.test(l) && !parseDate(l)
  ) || null

  return {
    supplier,
    date: parseDate(rawLines.join('\n')),
    reference: parseReference(rawLines.join('\n')),
    total: total ?? subtotal,
    lines,
  }
}
