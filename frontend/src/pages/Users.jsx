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

function formatTime(ts) {
  if (!ts) return 'Never'
  return new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

const isLocked = u => u.locked_until && new Date(u.locked_until) > new Date()

// Shown once after creating an account or resetting a password
function TemporaryPassword({ info, onClose }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(info.password)
      setCopied(true)
    } catch { /* clipboard blocked: the password is still visible to copy by hand */ }
  }

  return (
    <div className="mb-6 glass-card ring-1 ring-emerald-300/70 p-5">
      <p className="text-sm text-gray-700">
        {info.reset ? 'New temporary password' : 'Account created'} for <span className="font-semibold">@{info.username}</span>.
        Give them this password; they'll choose their own when they first sign in.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <code className="px-3 py-2 rounded-lg bg-white/80 border border-white/80 text-base font-mono tracking-wider text-gray-900 select-all">
          {info.password}
        </code>
        <button onClick={copy} className="btn-primary px-4 py-2">{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={onClose} className="ml-auto text-xs text-gray-500 hover:text-gray-700 font-medium">Done</button>
      </div>
      <p className="mt-2 text-xs text-amber-700">This password won't be shown again.</p>
    </div>
  )
}

export default function Users() {
  const me = useMe()
  const [users, setUsers] = useState([])
  const [form, setForm] = useState({ username: '', name: '', role: 'staff' })
  const [error, setError] = useState('')
  const [temp, setTemp] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/users')
      .then(r => r.json())
      .then(data => { setUsers(data); setLoading(false) })
  }, [])

  async function send(url, method, body) {
    setError('')
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.error || 'Something went wrong'); return null }
    return data
  }

  async function handleAdd(e) {
    e.preventDefault()
    const data = await send('/api/users', 'POST', form)
    if (!data) return
    const { temporary_password, ...user } = data
    setUsers(prev => [...prev, user])
    setTemp({ username: user.username, password: temporary_password })
    setForm({ username: '', name: '', role: 'staff' })
  }

  async function update(id, changes) {
    const data = await send(`/api/users/${id}`, 'PATCH', changes)
    if (data) setUsers(prev => prev.map(u => (u.id === id ? data : u)))
  }

  async function resetPassword(user) {
    if (!confirm(`Give @${user.username} a new temporary password? They will be signed out everywhere.`)) return
    const data = await send(`/api/users/${user.id}/reset-password`, 'POST')
    if (!data) return
    const { temporary_password, ...updated } = data
    setUsers(prev => prev.map(u => (u.id === user.id ? updated : u)))
    setTemp({ username: user.username, password: temporary_password, reset: true })
  }

  async function handleDelete(user) {
    if (!confirm(`Remove @${user.username}? They will no longer be able to sign in.`)) return
    setError('')
    const res = await apiFetch(`/api/users/${user.id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return setError(res.status === 409
        ? `@${user.username} has recorded stock history, so they can't be deleted. Deactivate them instead.`
        : data.error)
    }
    setUsers(prev => prev.filter(u => u.id !== user.id))
  }

  const inputClass = 'glass-input px-3 py-2 focus:ring-2 focus:ring-indigo-400/60'

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Users</h2>

      {temp && <TemporaryPassword info={temp} onClose={() => setTemp(null)} />}

      <div className="glass-card p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-1">Add User</h3>
        <p className="text-xs text-gray-500 mb-4">
          You'll get a temporary password to give them. They choose their own at first sign-in.
        </p>
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">{error}</div>
        )}
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3">
          <input
            type="text"
            autoCapitalize="none"
            placeholder="Username (e.g. kasir1)"
            value={form.username}
            onChange={e => setForm({ ...form, username: e.target.value })}
            className={`flex-1 min-w-[12rem] ${inputClass}`}
            required
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className={`w-48 ${inputClass}`}
          />
          <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className={`w-32 ${inputClass}`}>
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
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/50">
              {users.map(u => {
                const isMe = u.id === me.id
                return (
                  <tr key={u.id} className={`hover:bg-white/40 transition-colors ${u.active ? '' : 'opacity-50'}`}>
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-800">
                        {u.name || u.username}
                        {isMe && <span className="ml-2 text-xs font-normal text-indigo-500">(you)</span>}
                      </div>
                      <div className="text-xs text-gray-500">@{u.username}</div>
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
                    <td className="px-5 py-3 text-gray-500">{formatTime(u.last_login_at)}</td>
                    <td className="px-5 py-3">
                      {isLocked(u) ? (
                        <span className="text-xs text-red-600 font-medium" title="Too many wrong passwords. Reset the password to unlock.">
                          Locked
                        </span>
                      ) : u.must_change_password && u.active ? (
                        <span className="text-xs text-amber-600 font-medium">Awaiting first sign-in</span>
                      ) : isMe ? (
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
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {!isMe && (
                        <>
                          <button
                            onClick={() => resetPassword(u)}
                            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium transition-colors mr-4"
                          >
                            Reset password
                          </button>
                          <button
                            onClick={() => handleDelete(u)}
                            className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors"
                          >
                            Remove
                          </button>
                        </>
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
