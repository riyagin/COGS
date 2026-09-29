// Base URL for the API. Empty on the web (same origin); set VITE_API_URL for the
// Android build, which loads the UI from the device and calls the hosted API.
const API_BASE = import.meta.env.VITE_API_URL || ''
const TOKEN_KEY = 'cogs_session'

// Session token storage. Storage can be unavailable (private mode, blocked site data),
// so every access is guarded; without it the user just signs in again next visit.
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* session lasts until reload */ }
  memoryToken = token
  notifyAuthChanged()
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* nothing stored */ }
  memoryToken = null
  notifyAuthChanged()
}

// Fallback when localStorage throws
let memoryToken = null
const currentToken = () => getToken() || memoryToken

// AuthGate listens for this to re-check who is signed in
export const AUTH_CHANGED = 'cogs:auth-changed'
const notifyAuthChanged = () => window.dispatchEvent(new Event(AUTH_CHANGED))

// fetch() for /api calls: prefixes API_BASE and attaches the session token.
// 401 means the session ended (expired, password reset, deactivated): sign out.
// 403 must_change_password: let the gate show the change-password screen.
export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers)
  const token = currentToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(API_BASE + path, { ...options, headers })
  if (res.status === 401 && token) clearToken()
  if (res.status === 403 && res.headers.get('content-type')?.includes('json')) {
    const data = await res.clone().json().catch(() => ({}))
    if (data.code === 'must_change_password') notifyAuthChanged()
  }
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
