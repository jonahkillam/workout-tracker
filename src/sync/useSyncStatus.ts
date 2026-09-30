import { useLiveQuery } from 'dexie-react-hooks'
import { useSyncExternalStore } from 'react'
import { db } from '../db/db'
import { syncStatus } from './engine'

/** Sync state plus the number of local changes not yet on the server. */
export function useSyncStatus() {
  const status = useSyncExternalStore(syncStatus.subscribe, syncStatus.get)
  const pending = useLiveQuery(() => db.outbox.count(), []) ?? 0
  return { ...status, pending }
}
