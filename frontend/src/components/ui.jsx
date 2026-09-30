// Small shared building blocks for the pages.
import { TIERS, TIER_LABEL, qty } from '../lib/format'

export function Alert({ kind = 'error', children, onClose }) {
  if (!children) return null
  const styles = kind === 'error'
    ? 'text-red-600 bg-red-50/70 border-red-200/70'
    : 'text-emerald-700 bg-emerald-50/70 border-emerald-200/70'
  return (
    <div className={`mb-4 text-sm border px-3 py-2 rounded-lg flex items-start gap-2 ${styles}`}>
      <span className="flex-1">{children}</span>
      {onClose && <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Dismiss">×</button>}
    </div>
  )
}

const TIER_STYLE = {
  raw: 'bg-sky-100 text-sky-700',
  preprocessed: 'bg-amber-100 text-amber-700',
  final: 'bg-violet-100 text-violet-700',
}

export function TierBadge({ tier, short }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${TIER_STYLE[tier] || 'bg-gray-100 text-gray-600'}`}>
      {short ? tier : TIER_LABEL[tier] || tier}
    </span>
  )
}

// <select> of items grouped by tier. `tiers` limits which tiers are offered;
// `stock` (optional) is a Map id -> quantity shown next to each name.
export function ItemSelect({ items, value, onChange, tiers = TIERS, stock, placeholder = 'Select item', className = '', required = true, exclude = [] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60 ${className}`}
      required={required}
    >
      <option value="">{placeholder}</option>
      {tiers.map(tier => {
        const group = items.filter(i => i.tier === tier && !exclude.includes(i.id))
        if (group.length === 0) return null
        return (
          <optgroup key={tier} label={TIER_LABEL[tier]}>
            {group.map(i => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit_type}){stock ? ` — ${qty(stock.get(i.id) || 0)} in stock` : ''}
              </option>
            ))}
          </optgroup>
        )
      })}
    </select>
  )
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4 sm:mb-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold text-gray-800">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export function SectionTitle({ children, className = '' }) {
  return <h3 className={`text-sm font-semibold text-gray-500 uppercase tracking-wider ${className}`}>{children}</h3>
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1 mb-4 glass-card p-1 w-fit">
      {tabs.map(t => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
            value === t.value ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow' : 'text-gray-600 hover:bg-white/50'
          }`}
        >
          {t.label}{t.count != null ? <span className="ml-1.5 opacity-70">{t.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export const inputCls = 'w-full glass-input px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400/60'
export const labelCls = 'block text-xs font-medium text-gray-600 mb-1'
export const thCls = 'px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider'
export const secondaryBtn = 'bg-white/40 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/60 transition-colors'

// JSON helper for API calls: returns data, throws Error(message) on failure
export async function jsonOrThrow(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}
