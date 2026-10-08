import { useState } from 'react'
import AuthGate, { useMe } from '../../frontend/src/auth/AuthGate'
import Receipts from './pages/Receipts'
import StockMoves from './pages/StockMoves'
import Settings from './pages/Settings'

const PAGES = [
  { id: 'receipts', label: 'Receipts', hint: 'Photos → purchases', Page: Receipts },
  { id: 'stock', label: 'Stock moves', hint: 'Bulk in, out and counts', Page: StockMoves },
  { id: 'settings', label: 'Settings', hint: 'OCR, API key, learned matches', Page: Settings },
]

function Shell() {
  const me = useMe()
  const [page, setPage] = useState('receipts')
  const { Page } = PAGES.find(p => p.id === page)

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="glass-panel w-56 shrink-0 m-4 mr-0 rounded-2xl flex flex-col overflow-hidden">
        <div className="px-5 py-5 border-b border-white/50">
          <p className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest mb-0.5">COGS</p>
          <h1 className="text-lg font-bold leading-tight bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">Desktop</h1>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {PAGES.map(p => (
            <button key={p.id} type="button" onClick={() => setPage(p.id)}
              className={`w-full text-left px-3 py-2.5 rounded-xl transition-all ${page === p.id
                ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-[0_4px_14px_rgba(99,102,241,0.35)]'
                : 'text-gray-600 hover:bg-white/50 hover:text-gray-900'}`}>
              <span className="block text-sm font-medium">{p.label}</span>
              <span className={`block text-[11px] ${page === p.id ? 'text-white/80' : 'text-gray-400'}`}>{p.hint}</span>
            </button>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/50">
          <p className="text-sm font-medium text-gray-800 truncate">{me.name || me.username}</p>
          <p className="text-xs text-gray-500 truncate">{me.dev ? 'Local dev' : `@${me.username} · ${me.role}`}</p>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-6 overflow-y-auto">
        <Page />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  )
}
