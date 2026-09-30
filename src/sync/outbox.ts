// Records every local write to a synced table in `outbox`, inside the same IndexedDB transaction, so the sync
// engine knows what to push. It works below Dexie's API, so put, update, modify, delete and clear are all caught
// without the code doing the write knowing about sync. Push reads each key's current row: a missing row is a
// delete.
import Dexie, { type DBCore, type DBCoreMutateRequest, type DBCoreTable, type DBCoreTransaction, type Middleware } from 'dexie'

export const SYNCED_TABLES = ['workouts', 'weekNotes', 'settings', 'recordings'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

const SYNCED = new Set<string>(SYNCED_TABLES)

export interface OutboxEntry {
  table: SyncedTable
  key: string
  /** When the key was last written locally, ms. The server keeps the newest write. */
  ts: number
}

/** Marks a transaction's writes as coming from the server, so they aren't pushed back. */
const REMOTE = Symbol('remote')
type Tagged = DBCoreTransaction & { [REMOTE]?: boolean }

/**
 * Runs `fn` in a readwrite transaction whose writes aren't recorded in the outbox: for applying pulled changes
 * and for wiping local data.
 */
export function withoutOutbox<T>(db: Dexie, tables: string[], fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', tables, async (tx) => {
    ;(tx.idbtrans as unknown as Tagged)[REMOTE] = true
    return fn()
  })
}

// No native await in here or in mutate: Dexie tracks the current transaction in a zone that its own promises
// carry through `.then`, and the middleware below this one needs it.
function keysOf(table: DBCoreTable, req: DBCoreMutateRequest): string[] | Promise<string[]> {
  switch (req.type) {
    case 'add':
    case 'put':
      return req.keys ?? req.values.map((v) => table.schema.primaryKey.extractKey!(v))
    case 'delete':
      return req.keys
    case 'deleteRange':
      // clear() and ranged deletes: find the keys first so each becomes a tombstone.
      return table
        .query({ trans: req.trans, values: false, query: { index: table.schema.primaryKey, range: req.range } })
        .then((res) => res.result)
  }
}

export const outboxMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'outbox',
  create: (down) => ({
    ...down,
    transaction(stores, mode, options) {
      const needsOutbox = mode === 'readwrite' && stores.some((s) => SYNCED.has(s)) && !stores.includes('outbox')
      return down.transaction(needsOutbox ? [...stores, 'outbox'] : stores, mode, options)
    },
    table(name) {
      const table = down.table(name)
      if (!SYNCED.has(name)) return table
      const outbox = down.table('outbox')
      return {
        ...table,
        mutate(req) {
          if ((req.trans as Tagged)[REMOTE]) return table.mutate(req)
          const record = (keys: string[]) =>
            table.mutate(req).then((res) => {
              const ts = Date.now()
              const values = keys
                .filter((_, i) => !res.failures[i])
                .map((key): OutboxEntry => ({ table: name as SyncedTable, key, ts }))
              if (!values.length) return res
              return outbox.mutate({ type: 'put', trans: req.trans, values }).then(() => res)
            })
          const keys = keysOf(table, req)
          return Array.isArray(keys) ? record(keys) : keys.then(record)
        },
      }
    },
  }),
}
