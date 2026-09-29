import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { apiFetch, setToken, clearToken, AUTH_CHANGED } from '../lib/api'

const MeContext = createContext(null)

// The signed-in user: { id, username, name, role, must_change_password, dev }
export const useMe = () => useContext(MeContext)

export function signOut() {
  clearToken()
}

const inputClass = 'w-full glass-input px-3 py-2.5 focus:ring-2 focus:ring-indigo-400/60'

function ErrorBox({ children }) {
  return (
    <div className="mb-4 text-sm text-left text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">{children}</div>
  )
}

function Screen({ subtitle, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass-card w-full max-w-sm p-8">
        <div className="text-center mb-6">
          <p className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest mb-0.5">COGS</p>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
            Calculator
          </h1>
          {subtitle && <p className="text-sm text-gray-600 mt-3">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

function Login() {
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return setError(data.error || 'Sign-in failed')
      setToken(data.token)
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen subtitle="Sign in to continue">
      {error && <ErrorBox>{error}</ErrorBox>}
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          placeholder="Username"
          value={form.username}
          onChange={e => setForm({ ...form, username: e.target.value })}
          className={inputClass}
          required
          autoFocus
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={form.password}
          onChange={e => setForm({ ...form, password: e.target.value })}
          className={inputClass}
          required
        />
        <button type="submit" disabled={busy} className="btn-primary w-full px-4 py-2.5">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="text-xs text-gray-500 text-center mt-4">Forgot your password? Ask an admin to reset it.</p>
    </Screen>
  )
}

// Used both for the forced first-login change and the Account page
export function ChangePasswordForm({ currentLabel = 'Current password', onDone }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (form.next !== form.confirm) return setError('The new passwords do not match')
    setBusy(true)
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: form.current, new_password: form.next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return setError(data.error || 'Could not change password')
      setForm({ current: '', next: '', confirm: '' })
      setToken(data.token) // other devices are signed out; this one keeps going
      onDone?.()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <ErrorBox>{error}</ErrorBox>}
      <input type="password" autoComplete="current-password" placeholder={currentLabel} value={form.current}
        onChange={e => setForm({ ...form, current: e.target.value })} className={inputClass} required />
      <input type="password" autoComplete="new-password" placeholder="New password (at least 8 characters)" value={form.next}
        onChange={e => setForm({ ...form, next: e.target.value })} className={inputClass} minLength={8} required />
      <input type="password" autoComplete="new-password" placeholder="Repeat new password" value={form.confirm}
        onChange={e => setForm({ ...form, confirm: e.target.value })} className={inputClass} minLength={8} required />
      <button type="submit" disabled={busy} className="btn-primary w-full px-4 py-2.5">
        {busy ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  )
}

export default function AuthGate({ children }) {
  // status: loading | signed-out | ready | error
  const [status, setStatus] = useState('loading')
  const [me, setMe] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/me')
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) { setMe(null); return setStatus('signed-out') }
      if (!res.ok) { setError(data.error || 'Could not load your account'); return setStatus('error') }
      setMe(data)
      setStatus('ready')
    } catch {
      setError('Could not reach the server')
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    load()
    window.addEventListener(AUTH_CHANGED, load)
    return () => window.removeEventListener(AUTH_CHANGED, load)
  }, [load])

  if (status === 'loading') return <Screen subtitle="Loading…" />
  if (status === 'signed-out') return <Login />
  if (status === 'error') {
    return (
      <Screen subtitle={error}>
        <button onClick={load} className="btn-primary w-full px-4 py-2.5">Try again</button>
      </Screen>
    )
  }
  if (me.must_change_password) {
    return (
      <Screen subtitle={`Welcome, ${me.name || me.username}. Choose your own password to continue.`}>
        <ChangePasswordForm currentLabel="Temporary password" />
        <button onClick={signOut} className="w-full mt-3 text-xs text-gray-500 hover:text-gray-700">Sign out</button>
      </Screen>
    )
  }

  return <MeContext.Provider value={me}>{children}</MeContext.Provider>
}
