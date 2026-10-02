// Keeps the local Dexie database in step with Supabase. Local writes land in `outbox` (sync/outbox.ts) and are
// pushed in batches; the server's changes are pulled by rev cursor. The server keeps the newest write per key.
import { liveQuery } from 'dexie'
import { clearLocalData, db } from '../db/db'
import { supabase } from '../supabase'
import { SYNCED_TABLES, withoutOutbox, type SyncedTable } from './outbox'
import { LOCAL_TABLE, SERVER_TABLES, type Doc, type Row } from './rows'

/** An object as the server has it. `table` is the Dexie table name. */
export interface RemoteRow {
  table: SyncedTable
  key: string
  doc: Doc | null
  deleted: boolean
  rev: number
}

export interface Change {
  table: SyncedTable
  key: string
  doc: Doc | null
  deleted: boolean
  client_ts: number
}

/** The server side of sync. Supabase in the app; a fake in tests. */
export interface Remote {
  /** Applies changes; returns the ones the server already had a newer version of. */
  push(changes: Change[]): Promise<{ table: SyncedTable; key: string }[]>
  /** Changes after `since`, in rev order. */
  pull(since: number, limit: number): Promise<RemoteRow[]>
  /** The server's current rows for some keys. */
  fetch(table: SyncedTable, keys: string[]): Promise<RemoteRow[]>
}

interface ServerRow {
  table: string
  key: string
  row: Row
  deleted: boolean
  rev: number
}

const fromServer = (r: ServerRow): RemoteRow => {
  const table = LOCAL_TABLE[r.table]
  return { table, key: r.key, doc: r.deleted ? null : SERVER_TABLES[table].fromRow(r.row), deleted: r.deleted, rev: r.rev }
}

/**
 * Without a session a request would go out as nobody and be refused. That happens for a while after coming
 * back online: the Supabase client waits out a cooldown before it tries again to renew an expired session.
 */
async function requireSession() {
  if (!(await supabase.auth.getSession()).data.session) throw new Error('Waiting for sign-in to be renewed')
}

export const supabaseRemote: Remote = {
  async push(changes) {
    await requireSession()
    const rows = changes.map((c) => {
      const t = SERVER_TABLES[c.table]
      return { table: t.name, key: c.key, row: c.doc && t.toRow(c.doc), deleted: c.deleted, client_ts: c.client_ts }
    })
    const { data, error } = await supabase.rpc('sync_push', { changes: rows })
    if (error) throw error
    return (data as { table: string; key: string }[]).map((r) => ({ table: LOCAL_TABLE[r.table], key: r.key }))
  },
  async pull(since, limit) {
    await requireSession()
    const { data, error } = await supabase.rpc('sync_pull', { since, lim: limit })
    if (error) throw error
    return (data as ServerRow[]).map(fromServer)
  },
  async fetch(table, keys) {
    const t = SERVER_TABLES[table]
    const query = supabase.from(t.name).select('*')
    const { data, error } = await (t.key ? query.in(t.key, keys) : query)
    if (error) throw error
    return (data as (Row & { deleted: boolean; rev: number })[]).map((row) =>
      fromServer({ table: t.name, key: t.key ? String(row[t.key]) : 'settings', row, deleted: row.deleted, rev: row.rev }),
    )
  },
}

const PUSH_BATCH = 200
const PULL_PAGE = 500

/** Writes server rows locally, skipping keys with a local change still to push. */
export async function applyRemote(rows: RemoteRow[], cursor?: number) {
  await withoutOutbox(db, [...SYNCED_TABLES, 'recordingStreams', 'outbox', 'syncMeta'], async () => {
    for (const r of rows) {
      const { table } = r
      if (!SYNCED_TABLES.includes(table) || (await db.outbox.get([table, r.key]))) continue
      if (r.deleted || !r.doc) {
        await db.table(table).delete(r.key)
        if (table === 'recordings') await db.recordingStreams.delete(r.key)
        continue
      }
      await db.table(table).put(r.doc)
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
        return { table: e.table, key: e.key, doc: row ?? null, deleted: !row, client_ts: e.ts }
      }),
    )
    return { entries, changes }
  })
  if (!entries.length) return 0

  const rejected = await remote.push(changes)
  // Drop entries that weren't written again while the push was in flight.
  await db.transaction('rw', db.outbox, async () => {
    for (const e of entries) {
      const current = await db.outbox.get([e.table, e.key])
      if (current?.ts === e.ts) await db.outbox.delete([e.table, e.key])
    }
  })
  // The server has newer versions of these. Their revs may be behind the cursor (a pull skipped them while
  // they were pending here), so fetch them directly.
  const byTable = new Map<SyncedTable, string[]>()
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
let running: Promise<void> | null = null
let again = false

/** Pushes then pulls. Calls while one is running queue a single rerun. */
export function syncNow(): Promise<void> {
  // Known to be offline: leave it to the 'online' event rather than wait on requests that can't succeed.
  if (navigator.onLine === false) {
    setStatus({ error: 'Offline' })
    return Promise.resolve()
  }
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
export function startSync(using: Remote = supabaseRemote): () => void {
  remote = using
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
