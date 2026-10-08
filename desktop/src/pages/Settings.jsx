// Settings: how receipts are read, the Claude API key, and what the app has learned.
import { useEffect, useState } from 'react'
import { Alert, PageHeader, SectionTitle, inputCls, labelCls } from '../../../frontend/src/components/ui'
import { useMe, signOut } from '../../../frontend/src/auth/AuthGate'
import { Segmented } from '../components/bits'
import { desktop, usePersisted } from '../lib/desktop'
import { useReferenceData } from '../lib/data'

export const DEFAULT_SETTINGS = { engine: 'local', payment: 'cash' }

const API_URL = import.meta.env.VITE_API_URL || 'local backend (dev)'

export default function Settings() {
  const me = useMe()
  const [settings, setSettings] = usePersisted('settings', DEFAULT_SETTINGS)
  const [aliases, setAliases] = usePersisted('aliases', {})
  const { items, accounts } = useReferenceData()
  const [keyStatus, setKeyStatus] = useState({ hasKey: false, model: '' })
  const [keyInput, setKeyInput] = useState('')
  const [info, setInfo] = useState({})
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    desktop.apiKeyStatus().then(setKeyStatus)
    desktop.appInfo().then(setInfo)
  }, [])

  async function saveKey(value) {
    await desktop.setApiKey(value)
    setKeyInput('')
    setKeyStatus(await desktop.apiKeyStatus())
    setMessage(value ? 'API key saved (encrypted on this computer).' : 'API key removed.')
  }

  const describe = a => {
    if (a.kind === 'skip') return 'skipped'
    if (a.kind === 'expense') return `expense · ${accounts.find(x => x.id === a.account_id)?.name || `account ${a.account_id}`}`
    const item = items.find(x => x.id === a.item_id)
    return item ? `${item.name} · ${a.factor} ${item.unit_type} each` : `item ${a.item_id} (deleted?)`
  }
  const learned = Object.entries(aliases)
    .filter(([text]) => text.includes(filter.toLowerCase()))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Alert kind="success" onClose={() => setMessage('')}>{message}</Alert>

      <div className="glass-card p-5 space-y-5">
        <SectionTitle>Reading receipts</SectionTitle>
        <div>
          <span className={labelCls}>Read new photos with</span>
          <Segmented value={settings.engine} onChange={engine => setSettings(s => ({ ...s, engine }))} options={[
            { value: 'local', label: 'This computer (free, offline)' },
            { value: 'claude', label: 'Claude (more accurate)' },
          ]} />
          <p className="text-xs text-gray-500 mt-2">
            On this computer, Tesseract reads the text and the app works out the lines; it does best on flat, sharp, printed receipts.
            Claude also reads crumpled or handwritten notes, matches lines to your items and converts pack sizes. It costs a few
            cents (USD) per receipt, billed to your Anthropic account.
          </p>
        </div>

        <div>
          <span className={labelCls}>Anthropic API key {keyStatus.hasKey && <span className="text-emerald-600 font-semibold">· saved</span>}</span>
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (keyInput.trim()) saveKey(keyInput) }}>
            <input type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)} autoComplete="off"
              placeholder={keyStatus.hasKey ? '•••••••• (enter a new key to replace it)' : 'sk-ant-…'} className={inputCls} />
            <button type="submit" disabled={!keyInput.trim()} className="btn-primary px-4 py-2 shrink-0">Save key</button>
            {keyStatus.hasKey && (
              <button type="button" onClick={() => saveKey('')} className="text-xs font-medium text-red-500 hover:text-red-700 px-2 shrink-0">Remove</button>
            )}
          </form>
          <p className="text-xs text-gray-500 mt-2">
            Only needed for Claude. Create one at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-indigo-600 underline">console.anthropic.com</a>.
            Stored encrypted on this computer only. Model: {keyStatus.model}.
          </p>
        </div>

        <div>
          <span className={labelCls}>New receipts are paid with</span>
          <Segmented value={settings.payment} onChange={payment => setSettings(s => ({ ...s, payment }))} options={[
            { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'unpaid', label: 'Unpaid' },
          ]} />
        </div>
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <SectionTitle>Learned matches ({Object.keys(aliases).length})</SectionTitle>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search" className="glass-input px-2 py-1 text-sm w-48" />
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Each saved receipt teaches the app how its lines map to your items. Remove a wrong one and it is asked again next time.
        </p>
        {learned.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing learned yet.</p>
        ) : (
          <ul className="divide-y divide-white/50 max-h-80 overflow-y-auto text-sm">
            {learned.map(([text, a]) => (
              <li key={text} className="py-1.5 flex items-center gap-3">
                <span className="font-mono text-xs text-gray-600 flex-1 truncate" title={text}>{text}</span>
                <span className="text-gray-800 truncate">{describe(a)}</span>
                <button type="button" onClick={() => setAliases(all => { const next = { ...all }; delete next[text]; return next })}
                  className="text-gray-400 hover:text-red-500 px-1" aria-label="Forget">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card p-5 text-sm space-y-1.5">
        <SectionTitle className="mb-2">About</SectionTitle>
        <p><span className="text-gray-500">Signed in as</span> {me.name || me.username} (@{me.username}, {me.role})</p>
        <p><span className="text-gray-500">Server</span> {API_URL}</p>
        <p><span className="text-gray-500">Version</span> {info.version}</p>
        <p>
          <span className="text-gray-500">Local data</span>{' '}
          <button type="button" onClick={() => desktop.openDataDir()} className="text-indigo-600 hover:text-indigo-800 underline">{info.dataDir}</button>
        </p>
        {!me.dev && <button type="button" onClick={signOut} className="mt-2 text-sm font-medium text-indigo-600 hover:text-indigo-800">Sign out</button>}
      </div>
    </div>
  )
}
