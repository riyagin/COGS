import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { apiFetch } from '../lib/api'

const MeContext = createContext(null)

// The signed-in user as the API sees them: { id, email, name, role, dev }
export const useMe = () => useContext(MeContext)

export async function signOut() {
  if (supabase) await supabase.auth.signOut()
}

function Screen({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass-card w-full max-w-sm p-8 text-center">
        <p className="text-xs font-semibold text-indigo-500/80 uppercase tracking-widest mb-0.5">COGS</p>
        <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent mb-6">
          Calculator
        </h1>
        {children}
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

function Login() {
  const [error, setError] = useState('')

  async function signIn() {
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) setError(error.message)
  }

  return (
    <Screen>
      <p className="text-sm text-gray-600 mb-6">Sign in with the Google account your admin added.</p>
      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50/70 border border-red-200/70 px-3 py-2 rounded-lg">{error}</div>
      )}
      <button
        onClick={signIn}
        className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-lg bg-white/80 border border-white/80 text-sm font-medium text-gray-700 shadow-sm hover:bg-white transition-colors"
      >
        <GoogleIcon />
        Sign in with Google
      </button>
    </Screen>
  )
}

function Message({ text, action }) {
  return (
    <Screen>
      <p className="text-sm text-gray-600 mb-6">{text}</p>
      {action}
    </Screen>
  )
}

export default function AuthGate({ children }) {
  // undefined = still checking, null = signed out
  const [session, setSession] = useState(supabase ? undefined : null)
  const [me, setMe] = useState(null)
  const [meError, setMeError] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  // Ask the API who we are; it decides access from the allowlist
  const token = session?.access_token
  const signedInUser = session?.user?.id
  useEffect(() => {
    if (supabase && !session) return
    let cancelled = false
    setMeError('')
    apiFetch('/api/me')
      .then(async res => {
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok) setMe(data)
        else { setMe(null); setMeError(data.error || 'Could not load your account') }
      })
      .catch(() => !cancelled && setMeError('Could not reach the server'))
    return () => { cancelled = true }
    // Re-check only when the signed-in user changes, not on every token refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInUser, !!token])

  const signOutButton = (
    <button onClick={signOut} className="btn-primary w-full px-4 py-2.5">Sign out</button>
  )

  if (session === undefined) return <Message text="Loading…" />
  if (supabase && !session) return <Login />
  if (meError) return <Message text={meError} action={supabase && signOutButton} />
  if (!me) return <Message text="Loading…" />

  return <MeContext.Provider value={me}>{children}</MeContext.Provider>
}
