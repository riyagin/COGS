import { supabase } from './supabase'

// Base URL for the API. Empty on the web (same origin); set VITE_API_URL for the
// Android build, which loads the UI from the device and calls the hosted API.
const API_BASE = import.meta.env.VITE_API_URL || ''

// fetch() for /api calls: prefixes API_BASE and attaches the signed-in user's token.
// A 401 means the session is gone, so sign out and let the auth gate show the login screen.
export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers)
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  }
  const res = await fetch(API_BASE + path, { ...options, headers })
  if (res.status === 401 && supabase) await supabase.auth.signOut()
  return res
}

// Download a file from the API (plain <a href> links can't carry the auth header)
export async function apiDownload(path, fallbackName) {
  const res = await apiFetch(path)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Download failed')
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}
