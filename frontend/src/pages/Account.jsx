import { useState } from 'react'
import { useMe, ChangePasswordForm } from '../auth/AuthGate'

export default function Account() {
  const me = useMe()
  const [saved, setSaved] = useState(false)

  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4 sm:mb-6">Account</h2>

      <div className="glass-card p-4 sm:p-6 mb-6">
        <p className="text-sm text-gray-500">Signed in as</p>
        <p className="text-lg font-semibold text-gray-800">{me.name || me.username}</p>
        <p className="text-sm text-gray-500">@{me.username} · <span className="capitalize">{me.role}</span></p>
      </div>

      <div className="glass-card p-4 sm:p-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Change Password</h3>
        {saved && (
          <div className="mb-4 text-sm text-emerald-700 bg-emerald-50/70 border border-emerald-200/70 px-3 py-2 rounded-lg">
            Password changed. Your other devices have been signed out.
          </div>
        )}
        <ChangePasswordForm onDone={() => setSaved(true)} />
      </div>
    </div>
  )
}
