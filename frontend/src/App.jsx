import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import Products from './pages/Products'
import Inventory from './pages/Inventory'
import Recipes from './pages/Recipes'
import Production from './pages/Production'
import Invoices from './pages/Invoices'
import StockAdjust from './pages/StockAdjust'
import StockOpname from './pages/StockOpname'
import Users from './pages/Users'
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

function Sidebar() {
  const me = useMe()
  return (
    <aside className="glass-panel w-56 shrink-0 m-4 mr-0 rounded-2xl flex flex-col overflow-hidden">
      <div className="px-5 py-5 border-b border-white/50">
        <p className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest mb-0.5">COGS</p>
        <h1 className="text-lg font-bold leading-tight bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
          Calculator
        </h1>
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
        <p className="text-sm font-medium text-gray-800 truncate" title={me.email}>{me.name || me.email}</p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-xs text-gray-500">{me.dev ? 'Local dev (no sign-in)' : me.role[0].toUpperCase() + me.role.slice(1)}</span>
          {!me.dev && (
            <button onClick={signOut} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
              Sign out
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="p-8">
              <Routes>
                <Route path="/" element={<Navigate to="/products" replace />} />
                <Route path="/products" element={<Products />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/recipes" element={<Recipes />} />
                <Route path="/production" element={<Production />} />
                <Route path="/invoices" element={<Invoices />} />
                <Route path="/stock-adjust" element={<StockAdjust />} />
                <Route path="/stock-opname" element={<StockOpname />} />
                <Route path="/users" element={<Users />} />
              </Routes>
            </div>
          </main>
        </div>
      </AuthGate>
    </BrowserRouter>
  )
}
