// Keeps the local Dexie database in step with Supabase. Local writes land in `outbox` (sync/outbox.ts) and are
// pushed in batches; the server's changes are pulled by rev cursor. The server keeps the newest write per key.
import { liveQuery } from 'dexie'
import { clearLocalData, db } from '../db/db'
import { supabase } from '../supabase'
import { LOCAL_TABLE, normalizeDoc, SERVER_TABLE, type Doc } from './docs'
import { SYNCED_TABLES, withoutOutbox } from './outbox'
import { streamPath, supabaseStreamStore, uploadStreams, type StreamStore } from './streams'

export interface RemoteRow {
  table: string
  key: string
  doc: Doc | null
  deleted: boolean
  rev: number
}

export interface Change {
  table: string
  key: string
  doc: Doc | null
  deleted: boolean
  client_ts: number
}

/** The server side of sync. Supabase in the app; a fake in tests. */
export interface Remote {
  /** Applies changes; returns the ones the server already had a newer version of. */
  push(changes: Change[]): Promise<{ table: string; key: string }[]>
  /** Changes after `since`, in rev order. */
  pull(since: number, limit: number): Promise<RemoteRow[]>
  /** The server's current rows for some keys. */
  fetch(table: string, keys: string[]): Promise<RemoteRow[]>
}

export const supabaseRemote: Remote = {
  async push(changes) {
    const { data, error } = await supabase.rpc('sync_push', { changes })
    if (error) throw error
    return data as { table: string; key: string }[]
  },
  async pull(since, limit) {
    const { data, error } = await supabase.rpc('sync_pull', { since, lim: limit })
    if (error) throw error
    return data as RemoteRow[]
  },
  async fetch(table, keys) {
    const { data, error } = await supabase.from(table).select('key, doc, deleted, rev').in('key', keys)
    if (error) throw error
    return (data as Omit<RemoteRow, 'table'>[]).map((r) => ({ ...r, table }))
  },
}

const PUSH_BATCH = 200
const PULL_PAGE = 500

/** Writes server rows locally, skipping keys with a local change still to push. */
export async function applyRemote(rows: RemoteRow[], cursor?: number) {
  await withoutOutbox(db, [...SYNCED_TABLES, 'recordingStreams', 'outbox', 'syncMeta'], async () => {
    for (const r of rows) {
      const table = LOCAL_TABLE[r.table]
      if (!table || (await db.outbox.get([table, r.key]))) continue
      if (r.deleted || !r.doc) {
        await db.table(table).delete(r.key)
        if (table === 'recordings') await db.recordingStreams.delete(r.key)
        continue
      }
      const doc = normalizeDoc(table, r.doc)
      if (table === 'recordings' && typeof doc.stravaId === 'number') {
        // stravaId is unique locally; the server's row for the activity replaces any other local one.
        const clash = await db.recordings.where('stravaId').equals(doc.stravaId).first()
        if (clash && clash.id !== r.key) await db.recordings.delete(clash.id)
      }
      await db.table(table).put(doc)
    }
    if (cursor !== undefined) await db.syncMeta.update('sync', { cursor })
  })
}

/** Pushes one batch of the outbox. Returns how many entries it sent. */
async function pushBatch(remote: Remote): Promise<number> {
  const { entries, changes } = await db.transaction('r', [...SYNCED_TABLES, 'outbox'], async () => {
    const entries = await db.outbox.limit(PUSH_BATCH).toArray()
    const changes = await Promise.all(
      entries.map(async (e): Promise<Change> => {
        const row = (await db.table(e.table).get(e.key)) as Doc | undefined
        return { table: SERVER_TABLE[e.table], key: e.key, doc: row ?? null, deleted: !row, client_ts: e.ts }
      }),
    )
    return { entries, changes }
  })
  if (!entries.length) return 0

  const rejected = await remote.push(changes)
  // Deleted recordings take their streams with them. Best effort: an orphaned object only costs storage.
  const owner = (await db.syncMeta.get('sync'))?.owner
  const gone = changes.filter((c) => c.table === SERVER_TABLE.recordings && c.deleted)
  if (streams && owner && gone.length) await streams.remove(gone.map((c) => streamPath(owner, c.key))).catch(() => undefined)
  // Drop entries that weren't written again while the push was in flight.
  await db.transaction('rw', db.outbox, async () => {
    for (const e of entries) {
      const current = await db.outbox.get([e.table, e.key])
      if (current?.ts === e.ts) await db.outbox.delete([e.table, e.key])
    }
  })
  // The server has newer versions of these. Their revs may be behind the cursor (a pull skipped them while
  // they were pending here), so fetch them directly.
  const byTable = new Map<string, string[]>()
  for (const r of rejected) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.key])
  for (const [table, keys] of byTable) await applyRemote(await remote.fetch(table, keys))
  return entries.length
}

export async function push(remote: Remote) {
  while ((await pushBatch(remote)) === PUSH_BATCH);
}

export async function pull(remote: Remote) {
  for (;;) {
    const meta = await db.syncMeta.get('sync')
    const rows = await remote.pull(meta?.cursor ?? 0, PULL_PAGE)
    if (!rows.length) return
    await applyRemote(rows, rows[rows.length - 1].rev)
    if (rows.length < PULL_PAGE) return
  }
}

/** Makes the local database belong to `userId`, wiping another user's data first. */
export async function adoptOwner(userId: string) {
  const meta = await db.syncMeta.get('sync')
  if (meta?.owner === userId) return
  await clearLocalData()
  await db.syncMeta.put({ id: 'sync', owner: userId, cursor: 0 })
}

// Status, for the toolbar.

export interface SyncStatus {
  syncing: boolean
  lastSyncedAt?: number
  error?: string
}

let status: SyncStatus = { syncing: false }
const listeners = new Set<() => void>()

function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next }
  listeners.forEach((l) => l())
}

export const syncStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
}

// Running.

let remote: Remote = supabaseRemote
let streams: StreamStore | undefined
let running: Promise<void> | null = null
let again = false

/** Pushes then pulls. Calls while one is running queue a single rerun. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    setStatus({ syncing: true })
    try {
      do {
        again = false
        await push(remote)
        await pull(remote)
        if (streams) await uploadStreams(streams)
      } while (again)
      const now = Date.now()
      await db.syncMeta.update('sync', { lastSyncedAt: now })
      setStatus({ syncing: false, lastSyncedAt: now, error: undefined })
    } catch (e) {
      // Offline or server trouble: changes stay in the outbox for the next attempt.
      setStatus({ syncing: false, error: (e as Error).message })
    } finally {
      running = null
    }
  })()
  return running
}

let ready: Promise<void> = Promise.resolve()

/** Resolves once the first pull after sign-in has finished (or failed, when offline). */
export function whenReady() {
  return ready
}

/** Starts syncing. Call `adoptOwner` for the signed-in user first. Returns a function that stops it. */
export function startSync(using: Remote = supabaseRemote, streamStore: StreamStore = supabaseStreamStore): () => void {
  remote = using
  streams = streamStore
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void syncNow(), 1000)
  }
  ready = (async () => {
    const meta = await db.syncMeta.get('sync')
    setStatus({ lastSyncedAt: meta?.lastSyncedAt })
    await syncNow()
  })()

  // Push soon after local writes.
  const outbox = liveQuery(() => db.outbox.count()).subscribe((n) => n && schedule())
  const onWake = () => document.visibilityState === 'visible' && void syncNow()
  window.addEventListener('online', onWake)
  document.addEventListener('visibilitychange', onWake)
  const interval = setInterval(onWake, 60_000)
  return () => {
    clearTimeout(timer)
    clearInterval(interval)
    outbox.unsubscribe()
    window.removeEventListener('online', onWake)
    document.removeEventListener('visibilitychange', onWake)
  }
}
