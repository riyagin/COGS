import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumber, parseDate, parseReceipt } from '../src/lib/receiptParse.js'
import { packSize, sizeFactor, resolveLine, learn, score } from '../src/lib/matching.js'

test('parseNumber reads rupiah and quantities', () => {
  assert.equal(parseNumber('15.000'), 15000)
  assert.equal(parseNumber('15,000'), 15000)
  assert.equal(parseNumber('Rp15.000'), 15000)
  assert.equal(parseNumber('1.250.000'), 1250000)
  assert.equal(parseNumber('15.000,00'), 15000)
  assert.equal(parseNumber('-2.000'), -2000)
  assert.equal(parseNumber('(2.000)'), -2000)
  assert.equal(parseNumber('1,5'), 1.5)
  assert.equal(parseNumber('0.250'), 0.25)
  assert.equal(parseNumber('3O.OOO'), 30000) // OCR read zeros as O
  assert.equal(parseNumber('1KG'), null)
  assert.equal(parseNumber('ABC'), null)
})

test('parseDate understands day-first and month names', () => {
  assert.equal(parseDate('06/10/2026 14:02'), '2026-10-06')
  assert.equal(parseDate('Tgl 6-10-26'), '2026-10-06')
  assert.equal(parseDate('2026-10-06'), '2026-10-06')
  assert.equal(parseDate('06 Okt 2026'), '2026-10-06')
  assert.equal(parseDate('nothing here'), null)
})

const RECEIPT = `
TOKO SINAR JAYA
Jl. Pasar Baru No. 12
Telp 0812-3456-789
No: INV-20261006-001   06/10/2026
--------------------------------
TEPUNG TERIGU SEGITIGA 1KG   2 x 15.000   30.000
SUSU UHT ULTRA 1L
   3 @ 18.500            55.500
GULA PASIR 1KG                16.000
DISC                          -1.000
TELUR 10 PCS                  25.000
--------------------------------
SUBTOTAL                     126.500
TOTAL                        126.500
TUNAI                        150.000
KEMBALI                       23.500
TERIMA KASIH
`

test('parseReceipt pulls header, lines and total', () => {
  const r = parseReceipt(RECEIPT)
  assert.equal(r.supplier, 'TOKO SINAR JAYA')
  assert.equal(r.date, '2026-10-06')
  assert.equal(r.reference, 'INV-20261006-001')
  assert.equal(r.total, 126500)
  assert.deepEqual(r.lines.map(l => [l.description, l.quantity, l.amount]), [
    ['TEPUNG TERIGU SEGITIGA 1KG', 2, 30000],
    ['SUSU UHT ULTRA 1L', 3, 55500],
    ['GULA PASIR 1KG', 1, 15000],
    ['TELUR', 10, 25000],
  ])
})

test('price-then-amount and missing line totals', () => {
  const r = parseReceipt('MENTEGA BLUEBAND 200G 9.500 19.000\nKEJU 2x 20.000\nTOTAL 59.000')
  assert.deepEqual(r.lines.map(l => [l.quantity, l.unit_price, l.amount]), [[2, 9500, 19000], [2, 20000, 40000]])
  assert.equal(r.total, 59000)
})

test('pack sizes convert to the item unit', () => {
  assert.deepEqual(packSize('TERIGU SEGITIGA 1KG'), { dim: 'mass', base: 1000 })
  assert.equal(sizeFactor('TERIGU SEGITIGA 1KG', 'g'), 1000)
  assert.equal(sizeFactor('SUSU UHT 1L', 'mL'), 1000)
  assert.equal(sizeFactor('Mayo 500 gr', 'g'), 500)
  assert.equal(sizeFactor('SUSU UHT 1L', 'g'), null)   // volume vs mass
  assert.equal(sizeFactor('TELUR 10 PCS', 'piece'), null)
})

const items = [
  { id: 2, name: 'Terigu', unit_type: 'g' },
  { id: 4, name: 'Susu Ultra', unit_type: 'mL' },
  { id: 13, name: 'Telur', unit_type: 'piece' },
  { id: 16, name: 'Tepung Roti', unit_type: 'g' },
]
const accounts = [{ id: 40, name: 'Delivery' }]

test('fuzzy matching prefers the item whose words appear', () => {
  assert.ok(score('TEPUNG TERIGU SEGITIGA 1KG', 'Terigu') > score('TEPUNG TERIGU SEGITIGA 1KG', 'Tepung Roti'))
  const l = resolveLine({ description: 'TEPUNG TERIGU SEGITIGA 1KG', quantity: 2, amount: 30000 }, { items, accounts, aliases: {} })
  assert.equal(l.item_id, '2')
  assert.equal(l.quantity, '2000')
  assert.equal(l.match, 'guess')
})

test('learned aliases win and carry the conversion factor', () => {
  const first = resolveLine({ description: 'TELUR AYAM NEGERI 1 TRAY', quantity: 2, amount: 110000 }, { items, accounts, aliases: {} })
  const aliases = learn({}, [{ ...first, item_id: '13', quantity: '60' }])
  const again = resolveLine({ description: 'Telur ayam negeri 1 tray', quantity: 1, amount: 55000 }, { items, accounts, aliases })
  assert.equal(again.match, 'alias')
  assert.equal(again.item_id, '13')
  assert.equal(again.quantity, '30')
})

test('AI suggestions are used when there is no alias', () => {
  const l = resolveLine({ description: 'ONGKIR', quantity: 1, amount: 10000, kind: 'expense', account_id: 40 }, { items, accounts, aliases: {} })
  assert.equal(l.kind, 'expense')
  assert.equal(l.match, 'ai')
  const s = resolveLine({ description: 'UHT FULL CREAM 1000ML', quantity: 2, amount: 36000, kind: 'item', item_id: 4, item_quantity: 2000 }, { items, accounts, aliases: {} })
  assert.equal(s.item_id, '4')
  assert.equal(s.quantity, '2000')
})

test('OCR noise in the numbers line keeps the name from the line above', () => {
  const r = parseReceipt('TEPUNG TERIGU SEGITIGA 1KG\n2 Xx 15.000 30.000\nSUSU UHT 1L\n3 × 18.500 55.500')
  assert.deepEqual(r.lines.map(l => [l.description, l.quantity, l.amount]), [
    ['TEPUNG TERIGU SEGITIGA 1KG', 2, 30000],
    ['SUSU UHT 1L', 3, 55500],
  ])
})
