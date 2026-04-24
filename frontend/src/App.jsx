import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import Products from './pages/Products'
import Inventory from './pages/Inventory'
import Recipes from './pages/Recipes'
import Production from './pages/Production'
import Invoices from './pages/Invoices'

const NAV = [
  { to: '/products', label: 'Products' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/recipes', label: 'Recipes' },
  { to: '/production', label: 'Production' },
  { to: '/invoices', label: 'Invoices' },
]

function Sidebar() {
  return (
    <aside className="w-52 shrink-0 bg-gray-900 text-white flex flex-col">
      <div className="px-5 py-5 border-b border-gray-700">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">COGS</p>
        <h1 className="text-lg font-bold text-white leading-tight">Calculator</h1>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {NAV.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen bg-gray-100 overflow-hidden">
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
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  )
}
