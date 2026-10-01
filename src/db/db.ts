import Dexie, { type EntityTable, type Table } from 'dexie'
import {
  DEFAULT_SETTINGS,
  profileOf,
  THRESHOLD_KEYS,
  type Note,
  type Profile,
  type Recording,
  type RecordingStreams,
  type Settings,
  type StravaConnection,
  type StravaWeekFetch,
  type WeekNote,
  type Workout,
} from '../model/types'
import { outboxMiddleware, withoutOutbox, type OutboxEntry, type SyncedTable } from '../sync/outbox'

interface SettingsRow extends Settings {
  id: 'settings'
}

/** Sync bookkeeping: whose data this is and how far the pull has got. */
export interface SyncMeta {
  id: 'sync'
  /** Supabase user id the local data belongs to. */
  owner: string
  /** Highest server rev applied locally. */
  cursor: number
  lastSyncedAt?: number
}

/**
 * The browser's copy of the signed-in user's data. The UI reads and writes only this; `sync/engine.ts` keeps it
 * in step with Supabase.
 */
export const db = new Dexie('training-log-sync') as Dexie & {
  workouts: EntityTable<Workout, 'id'>
  weekNotes: EntityTable<WeekNote, 'weekStart'>
  settings: EntityTable<SettingsRow, 'id'>
  recordings: EntityTable<Recording, 'id'>
  recordingStreams: EntityTable<RecordingStreams, 'recordingId'>
  stravaWeekFetch: EntityTable<StravaWeekFetch, 'weekStart'>
  stravaConnection: EntityTable<StravaConnection, 'id'>
  outbox: Table<OutboxEntry, [SyncedTable, string]>
  syncMeta: EntityTable<SyncMeta, 'id'>
}

// Schema changes from here on: add a new db.version(n) with an upgrade; never edit this one. Synced objects
// also live in server tables, so a change to their shape needs a migration and a sync/rows.ts entry too.
db.version(1).stores({
  workouts: 'id, date, sport, updatedAt, recording.id',
  weekNotes: 'weekStart',
  settings: 'id',
  recordings: 'id, localDate',
  recordingStreams: 'recordingId',
  stravaWeekFetch: 'weekStart',
  stravaConnection: 'id',
  outbox: '[table+key]',
  syncMeta: 'id',
})

db.use(outboxMiddleware)

/** Wipes local data without queueing deletes for the server: on sign-out, or when another user signs in. */
export function clearLocalData() {
  return withoutOutbox(db, db.tables.map((t) => t.name), () => Promise.all(db.tables.map((t) => t.clear())))
}

/** Trims notes and drops empty ones. */
export function normalizeNotes(n: Note[]): Note[] | undefined {
  const kept = n.map(x => ({ ...x, text: x.text.trim() })).filter(x => x.text)
  return kept.length ? kept : undefined
}

export async function saveWorkout(w: Omit<Workout, 'id' | 'createdAt' | 'updatedAt'> & Partial<Workout>) {
  const now = Date.now()
  const row: Workout = {
    ...w,
    id: w.id ?? crypto.randomUUID(),
    profile: w.profile ?? profileOf(await loadSettings()),
    createdAt: w.createdAt ?? now,
    updatedAt: now,
  }
  await db.workouts.put(row)
  return row
}

export function deleteWorkout(id: string) {
  return db.workouts.delete(id)
}

export function saveWeekNote(weekStart: string, text: string) {
  return db.weekNotes.put({ weekStart, text, updatedAt: Date.now() })
}

export async function loadSettings(): Promise<Settings> {
  const row = await db.settings.get('settings')
  return { ...DEFAULT_SETTINGS, ...row }
}

/**
 * Saves settings. Workouts (and recordings, for unstructured activities) keep
 * the thresholds they were logged with, but any with no value recorded for a
 * threshold takes the newly set one.
 */
export async function saveSettings(s: Settings) {
  // Returns false when nothing changes, so Dexie skips the write.
  const fill = (row: { profile?: Profile }) => {
    if (!row.profile) {
      row.profile = profileOf(s)
      return true
    }
    const profile = row.profile
    const missing = THRESHOLD_KEYS.filter(k => profile[k] === undefined && s[k] !== undefined)
    for (const k of missing) profile[k] = s[k]
    return missing.length > 0
  }
  await db.transaction('rw', db.settings, db.workouts, db.recordings, async () => {
    await db.settings.put({ ...s, id: 'settings' })
    await db.workouts.toCollection().modify(fill)
    await db.recordings.toCollection().modify(fill)
  })
}

export interface ExportFile {
  version: 3
  exportedAt: string
  workouts: Workout[]
  weekNotes: WeekNote[]
  settings: Settings
  /** Recording summaries and laps. Streams are left out; they can be refetched. */
  recordings: Recording[]
}

export async function exportAll(): Promise<ExportFile> {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    workouts: await db.workouts.toArray(),
    weekNotes: await db.weekNotes.toArray(),
    settings: await loadSettings(),
    recordings: await db.recordings.toArray(),
  }
}

/** Merges an export into the database; newer records win. */
export async function importAll(data: ExportFile) {
  if (data.version !== 3) throw new Error(`Unsupported export version ${data.version}`)
  await db.transaction('rw', [db.workouts, db.weekNotes, db.settings, db.recordings], async () => {
    for (const w of data.workouts) {
      const existing = await db.workouts.get(w.id)
      if (!existing || existing.updatedAt < w.updatedAt) await db.workouts.put(w)
    }
    for (const n of data.weekNotes) {
      const existing = await db.weekNotes.get(n.weekStart)
      if (!existing || existing.updatedAt < n.updatedAt) await db.weekNotes.put(n)
    }
    for (const r of data.recordings) {
      const existing = await db.recordings.get(r.id)
      if (!existing || existing.updatedAt < r.updatedAt) await db.recordings.put(r)
    }
    await saveSettings({ ...DEFAULT_SETTINGS, ...data.settings })
  })
}
