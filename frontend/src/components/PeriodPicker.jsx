// Picks the date range a report or list covers: one day, week (Monday to Sunday), month or
// year that ◀ ▶ step through, or a custom from/to. Optionally also how to split it up
// (by day, week or month, or one total).
import { inputCls, labelCls } from './ui'

const pad = n => String(n).padStart(2, '0')
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

export const KINDS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Custom' },
]

export const GROUPS = [
  { value: 'total', label: 'Total' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]

// { kind, anchor, from, to } -> [from, to]
export function rangeOf(p) {
  if (p.kind === 'custom') return [p.from, p.to]
  const d = parse(p.anchor)
  switch (p.kind) {
    case 'day': return [p.anchor, p.anchor]
    case 'week': {
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
      return [iso(monday), iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))]
    }
    case 'year': return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`]
    default: return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), iso(new Date(d.getFullYear(), d.getMonth() + 1, 0))]
  }
}

function shift(p, step) {
  const d = parse(p.anchor)
  const moved = {
    day: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() + step),
    week: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * step),
    month: () => new Date(d.getFullYear(), d.getMonth() + step, 1),
    year: () => new Date(d.getFullYear() + step, 0, 1),
  }[p.kind]()
  return { ...p, anchor: iso(moved) }
}

const fmt = (s, opts) => parse(s).toLocaleDateString('en-GB', opts)

// "Mon 5 Oct 2026", "5 – 11 Oct 2026", "October 2026", "2026", "1 Sep – 31 Oct 2026"
export function rangeLabel(p) {
  const [from, to] = rangeOf(p)
  if (p.kind === 'day') return fmt(from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  if (p.kind === 'month') return fmt(from, { month: 'long', year: 'numeric' })
  if (p.kind === 'year') return from.slice(0, 4)
  return periodLabel({ from, to }, 'range')
}

// Label for one period of a report: { key, from, to } and the grouping it came from
export function periodLabel(period, group) {
  const { from, to } = period
  if (group === 'day') return fmt(from, { weekday: 'short', day: 'numeric', month: 'short' })
  if (group === 'month' && from.slice(0, 7) === to.slice(0, 7)) return fmt(from, { month: 'short', year: 'numeric' })
  if (from === to) return fmt(from, { day: 'numeric', month: 'short', year: 'numeric' })
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  const sameMonth = from.slice(0, 7) === to.slice(0, 7)
  const start = sameMonth ? fmt(from, { day: 'numeric' }) : fmt(from, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  return `${start} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

export const defaultPeriod = (kind = 'month') => {
  const today = iso(new Date())
  return { kind, anchor: today, from: `${today.slice(0, 7)}-01`, to: today }
}

const navBtn = 'p-2 rounded-lg text-gray-500 hover:bg-white/60 hover:text-gray-800'

const Chevron = ({ flip }) => (
  <svg viewBox="0 0 20 20" className={`w-4 h-4 ${flip ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.5 4.5L7 10l5.5 5.5" />
  </svg>
)

export default function PeriodPicker({ value, onChange, group, onGroupChange }) {
  const [from, to] = rangeOf(value)
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label className={labelCls}>Period</label>
        <select
          value={value.kind}
          onChange={e => onChange({ ...value, kind: e.target.value, from, to })}
          className={inputCls}
        >
          {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>

      {value.kind === 'custom' ? (
        <>
          <div><label className={labelCls}>From</label><input type="date" value={value.from} max={value.to} onChange={e => onChange({ ...value, from: e.target.value })} className={inputCls} required /></div>
          <div><label className={labelCls}>To</label><input type="date" value={value.to} min={value.from} onChange={e => onChange({ ...value, to: e.target.value })} className={inputCls} required /></div>
        </>
      ) : (
        <div className="flex items-center gap-1 glass-input !px-1 !py-0.5">
          <button type="button" onClick={() => onChange(shift(value, -1))} className={navBtn} aria-label="Previous"><Chevron /></button>
          <label className="relative cursor-pointer">
            <span className="block min-w-[9.5rem] text-center text-sm font-medium text-gray-800 px-1">{rangeLabel(value)}</span>
            {/* The label opens a date picker; any day inside the period picks that period */}
            <input
              type={value.kind === 'month' ? 'month' : 'date'}
              value={value.kind === 'month' ? value.anchor.slice(0, 7) : value.anchor}
              onChange={e => e.target.value && onChange({ ...value, anchor: value.kind === 'month' ? `${e.target.value}-01` : e.target.value })}
              onClick={e => { try { e.currentTarget.showPicker() } catch { /* older browsers: focus is enough */ } }}
              className="absolute inset-0 opacity-0 cursor-pointer"
              aria-label="Choose date"
            />
          </label>
          <button type="button" onClick={() => onChange(shift(value, 1))} className={navBtn} aria-label="Next"><Chevron flip /></button>
        </div>
      )}

      {onGroupChange && (
        <div>
          <label className={labelCls}>Show</label>
          <select value={group} onChange={e => onGroupChange(e.target.value)} className={inputCls}>
            {GROUPS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
