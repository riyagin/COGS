// Bridge to the Electron main process (electron/preload.cjs), plus a hook for state that
// survives closing the app.
import { useEffect, useRef, useState } from 'react'

export const desktop = window.desktop

// Like useState, but loaded from and saved to userData/data/<name>.json.
// `ready` is false until the saved value has been read.
export function usePersisted(name, initial) {
  const [value, setValue] = useState(initial)
  const [ready, setReady] = useState(false)
  const timer = useRef(null)
  const latest = useRef(value)

  useEffect(() => {
    let alive = true
    desktop.readStore(name, initial).then(saved => {
      if (!alive) return
      latest.current = saved
      setValue(saved)
      setReady(true)
    })
    return () => { alive = false }
  }, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return
    latest.current = value
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; desktop.writeStore(name, value) }, 300)
  }, [name, value, ready])

  // Flush a pending save when the page unmounts or the window closes
  useEffect(() => {
    const flush = () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      desktop.writeStore(name, latest.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('beforeunload', flush); flush() }
  }, [name, ready])

  return [value, setValue, ready]
}

export const newKey = () => Math.random().toString(36).slice(2, 10)
