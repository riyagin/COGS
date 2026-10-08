// Small UI pieces specific to the desktop pages.
import { useEffect, useState } from 'react'
import { desktop } from '../lib/desktop'
import { bytesToBlob } from '../lib/image'

export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div className="inline-flex rounded-lg border border-white/70 bg-white/40 p-0.5">
      {options.map(o => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)} title={o.title}
          className={`${size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} rounded-md font-medium transition-colors ${value === o.value ? 'bg-white shadow text-indigo-700' : 'text-gray-600 hover:text-gray-900'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const BADGE = {
  alias: ['bg-emerald-100 text-emerald-700', 'learned', 'Matched the way you did before'],
  ai: ['bg-violet-100 text-violet-700', 'AI', 'Suggested by Claude, check it'],
  guess: ['bg-amber-100 text-amber-700', 'guess', 'Closest name, check it'],
}

export function MatchBadge({ match }) {
  const b = BADGE[match]
  if (!b) return null
  return <span title={b[2]} className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${b[0]}`}>{b[1]}</span>
}

// Object URL for a stored receipt photo
export function useImageUrl(imageId) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!imageId) { setUrl(null); return }
    let created = null
    let alive = true
    desktop.readImage(imageId).then(bytes => {
      if (!alive) return
      created = URL.createObjectURL(bytesToBlob(bytes))
      setUrl(created)
    }).catch(() => setUrl(null))
    return () => { alive = false; if (created) URL.revokeObjectURL(created) }
  }, [imageId])
  return url
}

export function Spinner({ className = 'w-4 h-4' }) {
  return (
    <svg className={`animate-spin text-indigo-500 ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
