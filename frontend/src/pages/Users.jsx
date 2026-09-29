import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { useMe } from '../auth/AuthGate'

const ROLES = [
  { value: 'admin', label: 'Admin', hint: 'Everything, plus managing users' },
  { value: 'staff', label: 'Staff', hint: 'View and record stock, production, invoices' },
  { value: 'viewer', label: 'Viewer', hint: 'Read-only' },
]

const ROLE_BADGE = {
  admin: 'bg-violet-100 text-violet-700',
  staff: 'bg-indigo-100 text-indigo-700',
  viewer: 'bg-white/60 text-gray-600',
}

function formatLogin(ts) {
  if (!ts) return 'Never'
  return new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function Users() {
  const me = useMe()
  const [users, setUsers] = useState([])
  const [form, setForm] = useState({ email: '', name: '', role: 'staff' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/users')
      .then(r => r.json())
      .then(data => { setUsers(data); setLoading(false) })
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    setError('')
    const res = await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setUsers(prev => [...prev, data])
    setForm({ email: '', name: '', role: 'staff' })
  }

  async function update(id, changes) {
    setError('')
    const res = await apiFetch(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    })
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setUsers(prev => prev.map(u => (u.id === id ? data : u)))
  }

  async function handleDelete(user) {
    if (!confirm(`Remove ${user.email}? They will no longer be able to sign in.`)) return
    setError('')
    const res = await apiFetch(`/api/users/${user.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      return setError(res.status === 409
        ? `${user.email} has recorded stock history, so they can't be deleted. Deactivate them instead.`
        : data.error)
    }
    setUsers(prev => prev.filter(u => u.id !== user.id))
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Users</h2>

      <div className="glass-card p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-1">Give Access</h3>
        <p className="text-xs text-gray-500 mb-4">
          Add the Google account email. The person can sign in right away with “Sign in with Google”.
        </p>
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">{error}</div>
        )}
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3">
          <input
            type="email"
            placeholder="name@gmail.com"
            value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            className="flex-1 min-w-[14rem] glass-input px-3 py-2 focus:ring-2 focus:ring-indigo-400/60"
            required
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-48 glass-input px-3 py-2 focus:ring-2 focus:ring-indigo-400/60"
          />
          <select
            value={form.role}
            onChange={e => setForm({ ...form, role: e.target.value })}
            className="w-32 glass-input px-3 py-2 focus:ring-2 focus:ring-indigo-400/60"
          >
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button type="submit" className="btn-primary px-5 py-2">Add</button>
        </form>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          {ROLES.map(r => <li key={r.value}><span className="font-semibold text-gray-600">{r.label}:</span> {r.hint}</li>)}
        </ul>
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/30 border-b border-white/60">
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Last sign-in</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {users.map(u => {
                const isMe = u.id === me.id
                return (
                  <tr key={u.id} className={`hover:bg-white/40 transition-colors ${u.active ? '' : 'opacity-50'}`}>
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-800">
                        {u.name || u.email}
                        {isMe && <span className="ml-2 text-xs font-normal text-indigo-500">(you)</span>}
                      </div>
                      {u.name && <div className="text-xs text-gray-500">{u.email}</div>}
                    </td>
                    <td className="px-5 py-3">
                      {isMe ? (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[u.role]}`}>{u.role}</span>
                      ) : (
                        <select
                          value={u.role}
                          onChange={e => update(u.id, { role: e.target.value })}
                          className="glass-input px-2 py-1 text-xs focus:ring-2 focus:ring-indigo-400/60"
                        >
                          {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-500">{formatLogin(u.last_login_at)}</td>
                    <td className="px-5 py-3">
                      {isMe ? (
                        <span className="text-xs text-emerald-600 font-medium">Active</span>
                      ) : (
                        <button
                          onClick={() => update(u.id, { active: !u.active })}
                          className={`text-xs font-medium transition-colors ${
                            u.active ? 'text-emerald-600 hover:text-amber-600' : 'text-gray-500 hover:text-emerald-600'
                          }`}
                          title={u.active ? 'Click to deactivate' : 'Click to reactivate'}
                        >
                          {u.active ? 'Active' : 'Deactivated'}
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!isMe && (
                        <button
                          onClick={() => handleDelete(u)}
                          className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
