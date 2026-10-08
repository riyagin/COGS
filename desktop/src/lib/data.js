// Reference data from the API, shared by the pages.
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../frontend/src/lib/api'
import { jsonOrThrow } from '../../../frontend/src/components/ui'

// Accounts a purchase line may book to directly (same rule as the backend)
const isExpenseAccount = a => a.active && (['expense', 'cogs'].includes(a.type) || (a.type === 'asset' && !a.system_key))

export function useReferenceData() {
  const [items, setItems] = useState([])
  const [accounts, setAccounts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [error, setError] = useState('')

  const reloadItems = useCallback(() =>
    apiFetch('/api/items').then(jsonOrThrow).then(setItems).catch(e => setError(e.message)), [])

  useEffect(() => {
    reloadItems()
    apiFetch('/api/accounting/accounts').then(jsonOrThrow).then(all => setAccounts(all.filter(isExpenseAccount))).catch(e => setError(e.message))
    apiFetch('/api/purchases/suppliers').then(jsonOrThrow).then(setSuppliers).catch(() => {})
  }, [reloadItems])

  return { items, accounts, suppliers, error, reloadItems }
}
