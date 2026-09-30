// Shared formatting for money, quantities and dates (Indonesian locale, Rupiah).

export const rp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

// Signed money for reports: negatives in parentheses, as accountants write them
export const rpSigned = n => (Number(n) < -0.5 ? `(${rp(-n)})` : rp(n))

export const num = (n, d = 2) => Number(n || 0).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })

// Quantities: no forced decimals, at most 2
export const qty = n => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })

// Unit prices can be tiny (Rp 0.35/g), so keep decimals below Rp 100
export const unitRp = n => 'Rp ' + num(n, Math.abs(n) < 100 ? 2 : 0)

// Today as YYYY-MM-DD in the device's time zone (toISOString would give UTC's date)
export const today = () => new Date().toLocaleDateString('en-CA')

// A timestamp as "30 Sep 2026, 14:05" in the device's time zone
export const dateTime = ts => new Date(ts).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

export const shortDate = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export const monthLabel = ym => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

export const TIERS = ['raw', 'preprocessed', 'final']

export const TIER_LABEL = {
  raw: 'Raw material',
  preprocessed: 'Preprocessed',
  final: 'Final good',
}

export const TIER_HINT = {
  raw: 'Bought and used as-is (flour, milk, smoke beef, boxes)',
  preprocessed: 'Made here and used in other recipes (white sauce, kulit)',
  final: 'Made here and sold through products (risoles)',
}
