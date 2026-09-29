import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import Products from './pages/Products'
import Inventory from './pages/Inventory'
import Recipes from './pages/Recipes'
import Production from './pages/Production'
import Invoices from './pages/Invoices'
import StockAdjust from './pages/StockAdjust'
import StockOpname from './pages/StockOpname'
import Users from './pages/Users'
import Account from './pages/Account'
import AuthGate, { useMe, signOut } from './auth/AuthGate'

const NAV = [
  { to: '/products', label: 'Products' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/recipes', label: 'Recipes' },
  { to: '/production', label: 'Production' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/stock-adjust', label: 'Stock Adjust' },
  { to: '/stock-opname', label: 'Stock Opname' },
  { to: '/users', label: 'Users', adminOnly: true },
]

function Brand() {
  return (
    <div>
      <p className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest mb-0.5">COGS</p>
      <h1 className="text-lg font-bold leading-tight bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
        Calculator
      </h1>
    </div>
  )
}

// Navigation + account; rendered as a fixed column on desktop and inside the drawer on phones
function SidebarContent({ onClose }) {
  const me = useMe()
  return (
    <>
      <div className="px-5 py-5 border-b border-white/50 flex items-start justify-between">
        <Brand />
        {onClose && (
          <button onClick={onClose} className="md:hidden -mr-1 p-1 text-gray-500 hover:text-gray-800" aria-label="Close menu">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV.filter(n => !n.adminOnly || me.role === 'admin').map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-[0_4px_14px_rgba(99,102,241,0.35)]'
                  : 'text-gray-600 hover:bg-white/50 hover:text-gray-900'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="px-4 py-4 border-t border-white/50">
        {me.dev ? (
          <>
            <p className="text-sm font-medium text-gray-800">Local dev</p>
            <p className="text-xs text-gray-500 mt-0.5">Sign-in off (no AUTH_SECRET)</p>
          </>
        ) : (
          <>
            <NavLink to="/account" className="block group" title="Account and password">
              <p className="text-sm font-medium text-gray-800 truncate group-hover:text-indigo-700">{me.name || me.username}</p>
              <p className="text-xs text-gray-500 truncate">@{me.username} · {me.role[0].toUpperCase() + me.role.slice(1)}</p>
            </NavLink>
            <button onClick={signOut} className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
              Sign out
            </button>
          </>
        )}
      </div>
    </>
  )
}

function Shell({ children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const current = NAV.find(n => location.pathname.startsWith(n.to))?.label || (location.pathname === '/account' ? 'Account' : '')

  // Close the drawer after navigating
  useEffect(() => setMenuOpen(false), [location.pathname])

  return (
    <div className="flex h-dvh overflow-hidden safe-area">
      {/* Desktop: fixed glass column */}
      <aside className="hidden md:flex glass-panel w-56 shrink-0 m-4 mr-0 rounded-2xl flex-col overflow-hidden">
        <SidebarContent />
      </aside>

      {/* Phones: slide-out drawer */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[2px] transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setMenuOpen(false)}
      />
      <aside
        className={`md:hidden fixed z-50 top-0 bottom-0 left-0 w-72 max-w-[85vw] glass-panel !bg-white/80 rounded-r-2xl flex flex-col overflow-hidden safe-area-drawer transition-transform duration-200 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}
        aria-hidden={!menuOpen}
        // Closed drawer is off-screen: keep its links out of keyboard focus too
        inert={menuOpen ? undefined : ''}
      >
        <SidebarContent onClose={() => setMenuOpen(false)} />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Phones: top bar */}
        <header className="md:hidden glass-panel mx-3 mt-3 rounded-2xl px-3 py-2.5 flex items-center gap-3">
          <button onClick={() => setMenuOpen(true)} className="p-1.5 -ml-0.5 rounded-lg text-gray-700 hover:bg-white/60" aria-label="Open menu">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <span className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest">COGS</span>
          <span className="text-sm font-semibold text-gray-800 truncate">{current}</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="p-3 pt-4 sm:p-6 md:p-8">{children}</div>
        </main>
      </div>
    </div>
  )
}

// Non-admins who land on an admin page (e.g. an old URL after switching accounts) go home
function AdminOnly({ children }) {
  const me = useMe()
  return me.role === 'admin' ? children : <Navigate to="/products" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Shell>
          <Routes>
            <Route path="/" element={<Navigate to="/products" replace />} />
            <Route path="/products" element={<Products />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/recipes" element={<Recipes />} />
            <Route path="/production" element={<Production />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/stock-adjust" element={<StockAdjust />} />
            <Route path="/stock-opname" element={<StockOpname />} />
            <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
            <Route path="/account" element={<Account />} />
            <Route path="*" element={<Navigate to="/products" replace />} />
          </Routes>
        </Shell>
      </AuthGate>
    </BrowserRouter>
  )
}
