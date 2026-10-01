// Converts between the app's objects (Dexie rows) and the server's table rows (supabase/migrations): one column
// per field, snake_case, with timestamps as timestamptz and a workout's recording link spread over three columns.
import type { Recording, RecordingLink, Settings, WeekNote, Workout } from '../model/types'
import type { SyncedTable } from './outbox'

export type Doc = Record<string, unknown>
export type Row = Record<string, unknown>

/** Where one field goes: the column it's copied to as is, or a conversion of its own. */
type Field<V> = string | { toRow(value: V | undefined): Row; fromRow(row: Row): V | undefined }

/** Every field of `T` needs an entry, so a new field can't be left off the server by accident. */
type Fields<T> = { [K in keyof T]-?: Field<T[K]> }

export interface ServerTable {
  name: string
  /** The column holding the object's key; settings has one row per user instead. */
  key: string | null
  toRow(doc: Doc): Row
  fromRow(row: Row): Doc
}

function table<T>(name: string, key: string | null, fields: Fields<T>): ServerTable {
  const entries = Object.entries(fields) as [string, Field<unknown>][]
  return {
    name,
    key,
    toRow: (doc) =>
      Object.assign({}, ...entries.map(([k, f]) => (typeof f === 'string' ? { [f]: doc[k] ?? null } : f.toRow(doc[k])))),
    fromRow: (row) => {
      const doc: Doc = {}
      for (const [k, f] of entries) {
        const value = typeof f === 'string' ? row[f] : f.fromRow(row)
        // Optional fields are left out rather than null, as the app writes them.
        if (value !== null && value !== undefined) doc[k] = value
      }
      return doc
    },
  }
}

/** Milliseconds since the epoch, as timestamptz. */
const time = (column: string): Field<number> => ({
  toRow: (ms) => ({ [column]: ms === undefined ? null : new Date(ms).toISOString() }),
  fromRow: (row) => (typeof row[column] === 'string' ? Date.parse(row[column]) : undefined),
})

/** An ISO timestamp, as timestamptz. Read back in `toISOString` form (Postgres writes `+00:00`). */
const instant = (column: string): Field<string> => ({
  toRow: (iso) => ({ [column]: iso ?? null }),
  fromRow: (row) => (typeof row[column] === 'string' ? new Date(row[column]).toISOString() : undefined),
})

const recordingLink: Field<RecordingLink> = {
  toRow: (link) => ({
    recording_id: link?.id ?? null,
    recording_linked_by: link?.linkedBy ?? null,
    recording_offset: link?.offset ?? null,
  }),
  fromRow: (row) =>
    typeof row.recording_id === 'string'
      ? { id: row.recording_id, linkedBy: row.recording_linked_by as RecordingLink['linkedBy'], offset: Number(row.recording_offset ?? 0) }
      : undefined,
}

/** Dexie's settings row: the one `Settings` object, under a fixed key. */
type SettingsRow = Settings & { id: 'settings' }

export const SERVER_TABLES: Record<SyncedTable, ServerTable> = {
  workouts: table<Workout>('workouts', 'id', {
    id: 'id',
    date: 'date',
    sport: 'sport',
    title: 'title',
    notes: 'notes',
    rpe: 'rpe',
    duration: 'duration',
    rawText: 'raw_text',
    blocks: 'blocks',
    profile: 'profile',
    speedUnit: 'speed_unit',
    recording: recordingLink,
    unlinked: 'unlinked_recording_id',
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  }),
  weekNotes: table<WeekNote>('week_notes', 'week_start', {
    weekStart: 'week_start',
    text: 'text',
    updatedAt: time('updated_at'),
  }),
  settings: table<SettingsRow>('settings', null, {
    id: { toRow: () => ({}), fromRow: () => 'settings' },
    thresholdSpeed: 'threshold_speed',
    ftp: 'ftp',
    lthr: 'lthr',
    maxHr: 'max_hr',
    stairStepHeight: 'stair_step_height',
    stairFloorHeight: 'stair_floor_height',
    speedUnit: 'speed_unit',
  }),
  recordings: table<Recording>('recordings', 'id', {
    id: 'id',
    stravaId: 'strava_id',
    detailsFetched: 'details_fetched',
    noStreams: 'no_streams',
    startTime: instant('start_time'),
    localDate: 'local_date',
    sport: 'sport',
    rawSport: 'raw_sport',
    name: 'name',
    elapsed: 'elapsed',
    moving: 'moving',
    distance: 'distance',
    elevationGain: 'elevation_gain',
    avgHr: 'avg_hr',
    maxHr: 'max_hr',
    laps: 'laps',
    autoLogged: 'auto_logged',
    unstructured: 'unstructured',
    recorded: 'recorded',
    profile: 'profile',
    updatedAt: time('updated_at'),
  }),
}

/** The local table for a server table name. */
export const LOCAL_TABLE = Object.fromEntries(
  Object.entries(SERVER_TABLES).map(([local, t]) => [t.name, local as SyncedTable]),
) as Record<string, SyncedTable>
