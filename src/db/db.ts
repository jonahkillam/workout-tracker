import Dexie, { type EntityTable } from 'dexie'
import {
  DEFAULT_SETTINGS,
  profileOf,
  THRESHOLD_KEYS,
  type Profile,
  type Recording,
  type RecordingStreams,
  type Settings,
  type StravaAuth,
  type StravaWeekFetch,
  type WeekNote,
  type Workout,
} from '../model/types'

interface SettingsRow extends Settings {
  id: 'settings'
}

export const db = new Dexie('training-log') as Dexie & {
  workouts: EntityTable<Workout, 'id'>
  weekNotes: EntityTable<WeekNote, 'weekStart'>
  settings: EntityTable<SettingsRow, 'id'>
  recordings: EntityTable<Recording, 'id'>
  recordingStreams: EntityTable<RecordingStreams, 'recordingId'>
  stravaAuth: EntityTable<StravaAuth, 'id'>
  stravaWeekFetch: EntityTable<StravaWeekFetch, 'weekStart'>
}

// Schema changes from here on: add a new db.version(n) with an upgrade; never edit this one.
db.version(1).stores({
  workouts: 'id, date, sport, updatedAt, recording.id',
  weekNotes: 'weekStart',
  settings: 'id',
  recordings: 'id, localDate, &stravaId, fitHash, startTime',
  recordingStreams: 'recordingId',
  stravaAuth: 'id',
  stravaWeekFetch: 'weekStart',
})

/** Removes the pre-release database, which never held real data. */
export function removeLegacyDatabase() {
  return Dexie.delete('workout-tracker').catch(() => undefined)
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
  const fill = (row: { profile?: Profile }) => {
    row.profile ??= profileOf(s)
    for (const k of THRESHOLD_KEYS) if (row.profile[k] === undefined && s[k] !== undefined) row.profile[k] = s[k]
  }
  await db.transaction('rw', db.settings, db.workouts, db.recordings, async () => {
    await db.settings.put({ ...s, id: 'settings' })
    await db.workouts.toCollection().modify(fill)
    await db.recordings.toCollection().modify(fill)
  })
}

interface ExportFile {
  version: 2
  exportedAt: string
  workouts: Workout[]
  weekNotes: WeekNote[]
  settings: Settings
  /** Recording summaries and laps. Streams are left out; they can be refetched. */
  recordings: Recording[]
}

export async function exportAll(): Promise<ExportFile> {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    workouts: await db.workouts.toArray(),
    weekNotes: await db.weekNotes.toArray(),
    settings: await loadSettings(),
    recordings: await db.recordings.toArray(),
  }
}

/** Merges an export into the database; newer records win. */
export async function importAll(data: ExportFile) {
  if (data.version !== 2) throw new Error(`Unsupported export version ${data.version}`)
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
