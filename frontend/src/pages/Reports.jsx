import { useEffect, useMemo, useState } from 'react'
import { apiDownload, apiFetch } from '../lib/api'
import { rp, rpSigned, qty, dateTime, today } from '../lib/format'
import { Alert, PageHeader, Tabs, thCls, secondaryBtn, jsonOrThrow } from '../components/ui'
import PeriodPicker, { defaultPeriod, periodLabel, rangeLabel, rangeOf } from '../components/PeriodPicker'

const TABS = [
  { value: 'pnl', label: 'Profit & Loss' },
  { value: 'sales', label: 'Sales' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'balance', label: 'Balance Sheet' },
]

// What each report is split by until the user changes it
const DEFAULT_GROUP = { pnl: 'total', sales: 'day', expenses: 'total' }

const cardHead = 'px-4 py-3 border-b border-white/50'
const sectionRow = 'px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider'
const num = 'px-4 py-1.5 text-right whitespace-nowrap'

function useReport(path, params) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const query = new URLSearchParams(params).toString()
  useEffect(() => {
    let alive = true
    setError('')
    apiFetch(`${path}?${query}`).then(jsonOrThrow)
      .then(r => { if (alive) setReport(r) })
      .catch(e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [path, query])
  return [report, error, setError]
}

// Columns of a report: one per period when it is split up, then the total
function columnsOf(report) {
  const periods = report.group !== 'total' && report.periods.length > 1 ? report.periods : []
  return [...periods.map(p => ({ key: p.key, label: periodLabel(p, report.group) })), { key: 'total', label: 'Total' }]
}

// A wide table scrolls sideways with the account names kept in view
function WideTable({ children }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}
// Only needed once there are period columns to scroll past
const stickyOf = cols => (cols.length > 1 ? 'sticky left-0 z-10 bg-[#f4f5fd]/95 print:bg-white whitespace-nowrap' : '')

// In a table of periods, empty cells are a dash so the numbers stand out
const cellMoney = (v, cols) => (cols.length > 1 && Math.abs(v) < 0.5 ? '–' : rpSigned(v))

function AccountRows({ title, accounts, cols, totalLabel, totalOf }) {
  const stickyCell = stickyOf(cols)
  const span = cols.length + 1
  return (
    <>
      <tr><td colSpan={span} className={sectionRow}>{title}</td></tr>
      {accounts.length === 0 && <tr><td colSpan={span} className="px-6 py-1.5 text-gray-400 text-xs">Nothing recorded</td></tr>}
      {accounts.map(a => (
        <tr key={a.id}>
          <td className={`${stickyCell} px-4 py-1.5 text-gray-700`}>
            <span className="text-gray-400 tabular-nums mr-2">{a.code}</span>{a.name}
          </td>
          {cols.map(c => <td key={c.key} className={`${num} text-gray-600`}>{cellMoney(c.key === 'total' ? a.total : a.by_period[c.key] || 0, cols)}</td>)}
        </tr>
      ))}
      <tr className="border-t border-white/60">
        <td className={`${stickyCell} px-4 py-2 font-semibold text-gray-700`}>{totalLabel}</td>
        {cols.map(c => <td key={c.key} className={`${num} py-2 font-semibold text-gray-800`}>{cellMoney(totalOf(c.key), cols)}</td>)}
      </tr>
    </>
  )
}

// ── Profit & loss ────────────────────────────────────────────────────────────

function ProfitAndLoss({ params }) {
  const [report, error, setError] = useReport('/api/reports/pnl', params)
  if (!report) return <Alert onClose={() => setError('')}>{error}</Alert>

  const cols = columnsOf(report)
  const stickyCell = stickyOf(cols)
  const tot = (k, col) => (col === 'total' ? report.totals[k] : report.totals.by_period[col][k])

  const ProfitRow = ({ label, k, strong }) => (
    <tr className={strong ? 'bg-indigo-50/70' : 'bg-white/20'}>
      <td className={`${stickyCell} px-4 py-2.5 ${strong ? 'font-bold text-gray-900' : 'font-semibold text-gray-800'}`}>{label}</td>
      {cols.map(c => {
        const v = tot(k, c.key)
        const rev = tot('revenue', c.key)
        return (
          <td key={c.key} className={`px-4 py-2.5 text-right whitespace-nowrap ${strong ? 'font-bold' : 'font-semibold'} ${v < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
            {cellMoney(v, cols)}
            {rev > 0 && <span className="block text-[11px] font-normal text-gray-400">{((v / rev) * 100).toFixed(1)}% of revenue</span>}
          </td>
        )
      })}
    </tr>
  )

  return (
    <div className="glass-card overflow-hidden">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className={cardHead}>
        <p className="font-semibold text-gray-800">Profit & Loss</p>
        <p className="text-xs text-gray-500">{periodLabel(report, 'range')}</p>
      </div>
      <WideTable>
        <thead>
          <tr className="border-b border-white/60">
            <th className={`${thCls} ${stickyCell} text-left`}>Account</th>
            {cols.map(c => <th key={c.key} className={`${thCls} text-right whitespace-nowrap`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          <AccountRows title="Revenue" accounts={report.sections.revenue} cols={cols} totalLabel="Total revenue" totalOf={c => tot('revenue', c)} />
          <AccountRows title="Cost of goods sold" accounts={report.sections.cogs} cols={cols} totalLabel="Total cost of goods sold" totalOf={c => tot('cogs', c)} />
          <ProfitRow label="Gross profit" k="gross_profit" />
          <AccountRows title="Expenses" accounts={report.sections.expense} cols={cols} totalLabel="Total expenses" totalOf={c => tot('expense', c)} />
          <ProfitRow label="Net profit" k="net_profit" strong />
        </tbody>
      </WideTable>
      <p className="px-4 py-3 text-xs text-gray-400 border-t border-white/50">
        Café sales come from KSK Desktop. Cost of goods sold is the FIFO cost of what was sold through invoices, plus
        stock used up, written off or found in adjustments and stock counts. Stock bought is not a cost until it is used.
      </p>
    </div>
  )
}

// ── Sales ────────────────────────────────────────────────────────────────────

function Sales({ params }) {
  const [report, error, setError] = useReport('/api/reports/sales', params)
  if (!report) return <Alert onClose={() => setError('')}>{error}</Alert>
  const { totals, pos_status: pos } = report
  const showPeriods = report.group !== 'total' && report.periods.length > 1

  return (
    <div className="space-y-5">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <p className="text-xs text-gray-500 print:hidden">
        {pos.count > 0
          ? <>Café sales are pushed from KSK Desktop: {qty(pos.count)} on the server, latest business day {pos.last_business_day}, last pushed {dateTime(pos.last_synced_at)}.</>
          : <>No café sales on the server yet. Push them from KSK Desktop (Sinkronisasi → Server COGS).</>}
      </p>

      <div className="glass-card overflow-hidden">
        <div className={cardHead}>
          <p className="font-semibold text-gray-800">Sales</p>
          <p className="text-xs text-gray-500">{periodLabel(report, 'range')}</p>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 px-4 py-4 border-b border-white/50">
          {[
            ['Net sales', rp(totals.net)],
            ['Sales', qty(totals.count)],
            ['Average sale', rp(totals.count ? totals.total / totals.count : 0)],
            ['Discounts given', rp(totals.discount)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="text-lg font-bold text-gray-800 whitespace-nowrap">{value}</dd>
            </div>
          ))}
        </dl>
        <WideTable>
          <thead>
            <tr className="border-b border-white/60">
              <th className={`${thCls} text-left`}>{showPeriods ? 'Period' : ''}</th>
              <th className={`${thCls} text-right`}>Sales</th>
              <th className={`${thCls} text-right`}>Gross</th>
              <th className={`${thCls} text-right`}>Discounts</th>
              <th className={`${thCls} text-right`}>Tax</th>
              <th className={`${thCls} text-right`}>Net sales</th>
            </tr>
          </thead>
          <tbody>
            {showPeriods && report.periods.map(p => (
              <tr key={p.key} className={`border-t border-white/40 ${p.count === 0 ? 'text-gray-400' : 'text-gray-700'}`}>
                <td className="px-4 py-1.5 whitespace-nowrap">{periodLabel(p, report.group)}</td>
                <td className={num}>{qty(p.count)}</td>
                <td className={num}>{rp(p.gross)}</td>
                <td className={num}>{p.discount ? `(${rp(p.discount)})` : '—'}</td>
                <td className={num}>{p.tax ? rp(p.tax) : '—'}</td>
                <td className={`${num} font-medium`}>{rp(p.net)}</td>
              </tr>
            ))}
            <tr className="border-t border-white/70 bg-indigo-50/60 font-semibold text-gray-900">
              <td className="px-4 py-2">Total</td>
              <td className={num}>{qty(totals.count)}</td>
              <td className={num}>{rp(totals.gross)}</td>
              <td className={num}>{totals.discount ? `(${rp(totals.discount)})` : '—'}</td>
              <td className={num}>{totals.tax ? rp(totals.tax) : '—'}</td>
              <td className={num}>{rp(totals.net)}</td>
            </tr>
          </tbody>
        </WideTable>
        <p className="px-4 py-3 text-xs text-gray-400 border-t border-white/50">
          Net sales = what customers paid, less tax. It matches revenue on the Profit & Loss.
          {report.by_source.invoice.count > 0 && ` Café POS ${rp(report.by_source.pos.net)} · invoices ${rp(report.by_source.invoice.net)}.`}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5 items-start">
        <div className="glass-card overflow-hidden">
          <div className={cardHead}><p className="font-semibold text-gray-800">By product</p></div>
          {report.by_product.length === 0 ? <p className="p-6 text-center text-sm text-gray-400">No sales in this period.</p> : (
            <WideTable>
              <thead>
                <tr className="border-b border-white/60">
                  <th className={`${thCls} text-left`}>Product</th>
                  <th className={`${thCls} text-right`}>Qty</th>
                  <th className={`${thCls} text-right`}>Amount</th>
                  <th className={`${thCls} text-right`}>Share</th>
                </tr>
              </thead>
              <tbody>
                {report.by_product.map(p => (
                  <tr key={`${p.source}:${p.name}`} className="border-t border-white/40 text-gray-700">
                    <td className="px-4 py-1.5">
                      {p.name}
                      <span className="ml-2 text-[11px] text-gray-400">{p.category || (p.source === 'invoice' ? 'Invoice' : '')}</span>
                    </td>
                    <td className={num}>{qty(p.qty)}</td>
                    <td className={num}>{rp(p.amount)}</td>
                    <td className={`${num} text-gray-500`}>{totals.gross ? `${((p.amount / totals.gross) * 100).toFixed(1)}%` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </WideTable>
          )}
          <p className="px-4 py-3 text-xs text-gray-400 border-t border-white/50">Line amounts after line discounts, before whole-sale discounts.</p>
        </div>

        <div className="glass-card overflow-hidden">
          <div className={cardHead}><p className="font-semibold text-gray-800">By payment</p></div>
          <table className="w-full text-sm">
            <tbody>
              {report.by_payment.length === 0 && <tr><td className="p-6 text-center text-gray-400">—</td></tr>}
              {report.by_payment.map(p => (
                <tr key={p.method} className="border-t border-white/40 text-gray-700 first:border-0">
                  <td className="px-4 py-2">{p.method}<span className="block text-[11px] text-gray-400">{qty(p.count)} payments</span></td>
                  <td className={num}>{rp(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Expenses ─────────────────────────────────────────────────────────────────

function Expenses({ params }) {
  const [report, error, setError] = useReport('/api/reports/expenses', params)
  if (!report) return <Alert onClose={() => setError('')}>{error}</Alert>
  const cols = columnsOf(report)
  const stickyCell = stickyOf(cols)
  const tot = (k, col) => (col === 'total' ? report.totals[k] : report.totals.by_period[col][k])
  const stock = col => (col === 'total' ? report.stock_bought.total : report.stock_bought.by_period[col] || 0)

  return (
    <div className="glass-card overflow-hidden">
      <Alert onClose={() => setError('')}>{error}</Alert>
      <div className={cardHead}>
        <p className="font-semibold text-gray-800">Expenses</p>
        <p className="text-xs text-gray-500">{periodLabel(report, 'range')}</p>
      </div>
      <WideTable>
        <thead>
          <tr className="border-b border-white/60">
            <th className={`${thCls} ${stickyCell} text-left`}>Account</th>
            {cols.map(c => <th key={c.key} className={`${thCls} text-right whitespace-nowrap`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          <AccountRows title="Operating expenses" accounts={report.sections.expense} cols={cols} totalLabel="Total operating expenses" totalOf={c => tot('expense', c)} />
          <AccountRows title="Cost of goods sold" accounts={report.sections.cogs} cols={cols} totalLabel="Total cost of goods sold" totalOf={c => tot('cogs', c)} />
          <tr className="bg-indigo-50/70">
            <td className={`${stickyCell} px-4 py-2.5 font-bold text-gray-900`}>Total costs</td>
            {cols.map(c => <td key={c.key} className="px-4 py-2.5 text-right whitespace-nowrap font-bold text-gray-900">{cellMoney(tot('total', c.key), cols)}</td>)}
          </tr>
          <tr className="text-gray-500">
            <td className={`${stickyCell} px-4 py-2.5`}>Stock bought <span className="text-[11px] text-gray-400">(not a cost until used)</span></td>
            {cols.map(c => <td key={c.key} className="px-4 py-2.5 text-right whitespace-nowrap">{cellMoney(stock(c.key), cols)}</td>)}
          </tr>
        </tbody>
      </WideTable>
      <p className="px-4 py-3 text-xs text-gray-400 border-t border-white/50">
        Record rent, wages, electricity and other spending under Expenses in the menu. Each expense is booked to its
        account here; new expense categories get the next free account number.
      </p>
    </div>
  )
}

// ── Balance sheet ────────────────────────────────────────────────────────────

const TYPE_LABEL = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity' }

function BalanceSheet({ date }) {
  const [report, error, setError] = useReport('/api/accounting/balance-sheet', { date })
  if (!report) return <Alert onClose={() => setError('')}>{error}</Alert>

  const Section = ({ type, total }) => (
    <>
      <tr><td colSpan={2} className={sectionRow}>{TYPE_LABEL[type]}</td></tr>
      {report.sections[type].map(a => (
        <tr key={a.id ?? a.name}>
          <td className="px-4 py-1.5 text-gray-700"><span className="text-gray-400 tabular-nums mr-2">{a.code}</span>{a.name}</td>
          <td className={`${num} text-gray-600`}>{rpSigned(a.balance)}</td>
        </tr>
      ))}
      <tr className="border-t border-white/60">
        <td className="px-4 py-2 font-semibold text-gray-700">Total {TYPE_LABEL[type].toLowerCase()}</td>
        <td className={`${num} py-2 font-semibold text-gray-800`}>{rpSigned(total)}</td>
      </tr>
    </>
  )

  return (
    <div className="glass-card overflow-hidden max-w-2xl">
      <div className={cardHead}>
        <p className="font-semibold text-gray-800">Balance Sheet</p>
        <p className="text-xs text-gray-500">As of {periodLabel({ from: report.date, to: report.date }, 'range')}</p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          <Section type="asset" total={report.totals.assets} />
          <Section type="liability" total={report.totals.liabilities} />
          <Section type="equity" total={report.totals.equity} />
          <tr className="bg-indigo-50/70">
            <td className="px-4 py-2.5 font-bold text-gray-900">Liabilities + equity</td>
            <td className={`${num} py-2.5 font-bold text-gray-900`}>{rpSigned(report.totals.liabilities_and_equity)}</td>
          </tr>
        </tbody>
      </table>
      <p className={`px-4 py-3 text-xs border-t border-white/50 ${report.totals.balanced ? 'text-emerald-600' : 'text-red-600'}`}>
        {report.totals.balanced ? '✓ Assets equal liabilities + equity' : 'Books do not balance. Check the journal.'}
        {report.sections.asset.some(a => a.name === 'Cash' && a.balance < 0) && (
          <span className="block text-amber-700 mt-1">Cash is negative: record the money you started with as “Owner puts in capital” in Accounting → Journal.</span>
        )}
      </p>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Reports() {
  const [tab, setTab] = useState('pnl')
  const [period, setPeriod] = useState(() => defaultPeriod('month'))
  const [groups, setGroups] = useState(DEFAULT_GROUP)
  const [error, setError] = useState('')

  // The current day, week, month or year runs up to today, not into days that haven't happened
  const [from, end] = rangeOf(period)
  const to = period.kind !== 'custom' && end > today() && from <= today() ? today() : end
  const group = groups[tab]
  const params = useMemo(() => ({ from, to, group }), [from, to, group])
  // A balance sheet is a moment: the end of the chosen period, or today if that is later
  const asOf = to > today() ? today() : to

  async function exportCsv() {
    setError('')
    try {
      await apiDownload(`/api/reports/${tab}?${new URLSearchParams({ ...params, format: 'csv' })}`, `${tab}_${from}_${to}.csv`)
    } catch (e) { setError(e.message) }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader title="Reports" subtitle={`${TABS.find(t => t.value === tab).label} · ${tab === 'balance' ? `as of ${asOf}` : rangeLabel(period)}`} />
      <div className="print:hidden">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <PeriodPicker
            value={period}
            onChange={setPeriod}
            group={group}
            onGroupChange={tab === 'balance' ? undefined : g => setGroups({ ...groups, [tab]: g })}
          />
          <div className="flex gap-2 ml-auto">
            {tab !== 'balance' && <button type="button" onClick={exportCsv} className={secondaryBtn}>Export CSV</button>}
            <button type="button" onClick={() => window.print()} className={secondaryBtn}>Print</button>
          </div>
        </div>
        <Alert onClose={() => setError('')}>{error}</Alert>
      </div>

      {tab === 'pnl' && <ProfitAndLoss params={params} />}
      {tab === 'sales' && <Sales params={params} />}
      {tab === 'expenses' && <Expenses params={params} />}
      {tab === 'balance' && <BalanceSheet date={asOf} />}
    </div>
  )
}
