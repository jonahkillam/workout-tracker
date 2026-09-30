// The database from before accounts (`training-log`). It isn't migrated into the account. Settings offers it as a
// backup download, which can then be imported, or deletes it.
import Dexie from 'dexie'
import { DEFAULT_SETTINGS, type Settings, type Workout } from '../model/types'
import { normalizeNotes, type ExportFile } from './db'

export const LEGACY_DB = 'training-log'

export function hasLegacyData(): Promise<boolean> {
  return Dexie.exists(LEGACY_DB)
}

/**
 * Reads the old database as an export file. It's opened without declaring a schema, so whichever version it's at
 * is read as-is and nothing is upgraded or written. Workout notes from before categories are converted.
 */
export async function exportLegacy(now = new Date()): Promise<ExportFile> {
  const old = new Dexie(LEGACY_DB)
  await old.open()
  try {
    const all = async <T>(name: string): Promise<T[]> =>
      old.tables.some((t) => t.name === name) ? old.table(name).toArray() : []
    const [row] = await all<Settings & { id?: string }>('settings')
    const settings = { ...DEFAULT_SETTINGS, ...row }
    delete settings.id
    const workouts = await all<Workout & { notes?: unknown }>('workouts')
    return {
      version: 3,
      exportedAt: now.toISOString(),
      workouts: workouts.map((w) => ({ ...w, notes: normalizeNotes(w.notes) })),
      weekNotes: await all('weekNotes'),
      settings,
      recordings: await all('recordings'),
    }
  } finally {
    old.close()
  }
}

export function deleteLegacy(): Promise<void> {
  return Dexie.delete(LEGACY_DB)
}
