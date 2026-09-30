// How local tables map to server tables, and how documents from the server are brought up to the current shape.
import { normalizeNotes } from '../db/db'
import type { SyncedTable } from './outbox'

export const SERVER_TABLE: Record<SyncedTable, string> = {
  workouts: 'workouts',
  weekNotes: 'week_notes',
  settings: 'settings',
  recordings: 'recordings',
}

export const LOCAL_TABLE: Record<string, SyncedTable | undefined> = Object.fromEntries(
  Object.entries(SERVER_TABLE).map(([local, server]) => [server, local as SyncedTable]),
)

export type Doc = Record<string, unknown>

/**
 * Brings a pulled document up to the current shape. Dexie upgrades only reach local rows, while the server can
 * hold documents written by older versions of the app, so every change to a synced type's shape needs a case here.
 */
export function normalizeDoc(table: SyncedTable, doc: Doc): Doc {
  if (table === 'workouts') {
    // Notes were a single string before categories.
    const { notes, ...rest } = doc
    const normalized = normalizeNotes(notes)
    return normalized ? { ...rest, notes: normalized } : rest
  }
  return doc
}
