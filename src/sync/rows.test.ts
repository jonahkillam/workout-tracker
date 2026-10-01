import { describe, expect, it } from 'vitest'
import type { Recording, WeekNote, Workout } from '../model/types'
import { SERVER_TABLES, type Doc, type Row } from './rows'

const profile = { thresholdSpeed: 15, ftp: 250, lthr: 170, maxHr: 190, stairStepHeight: 0.2, stairFloorHeight: 3.25 }

const workout: Workout = {
  id: 'w1',
  date: '2026-09-29',
  sport: 'run',
  title: 'Intervals',
  notes: [{ kind: 'fuel', text: 'Gel at 40m' }],
  rpe: 7.5,
  duration: 3600,
  rawText: '5x3m/2m @ 4:00/km',
  blocks: [{ type: 'repeat', count: 5, children: [], skipLastRest: true }],
  profile,
  speedUnit: 'pace',
  recording: { id: 'strava-1', linkedBy: 'manual', offset: 12.5 },
  unlinked: 'strava-2',
  createdAt: 1790000000123,
  updatedAt: 1790000000456,
}

const recording: Recording = {
  id: 'strava-1',
  stravaId: 12345678901,
  detailsFetched: true,
  noStreams: false,
  startTime: '2026-09-29T07:00:00.000Z',
  localDate: '2026-09-29',
  sport: 'ride',
  rawSport: 'Ride',
  name: 'Morning Ride',
  elapsed: 3700,
  moving: 3600,
  distance: 30123.4,
  elevationGain: 250,
  avgHr: 141.3,
  maxHr: 172,
  laps: [{ start: 0, duration: 600, distance: 5000 }],
  autoLogged: true,
  unstructured: false,
  recorded: { moving: 3600, distance: 30123.4, power: { bin: 5, secs: [0, 10, 20] } },
  profile,
  updatedAt: 1790000000789,
}

const note: WeekNote = { weekStart: '2026-09-28', text: 'Taper', updatedAt: 1790000000000 }
const settings = { id: 'settings', ...profile, speedUnit: 'kmh' }

/** What a row looks like read back from Postgres: JSON, with timestamptz written as `+00:00`. */
function asPostgres(row: Row): Row {
  const out = JSON.parse(JSON.stringify(row)) as Row
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) out[k] = v.replace(/Z$/, '+00:00')
  }
  return out
}

describe('server rows', () => {
  it.each([
    ['workouts', workout],
    ['recordings', recording],
    ['weekNotes', note],
    ['settings', settings],
  ] as const)('round-trips a full %s object', (table, doc) => {
    const t = SERVER_TABLES[table]
    expect(t.fromRow(asPostgres(t.toRow(doc as unknown as Doc)))).toEqual(doc)
  })

  it('leaves optional fields out rather than null', () => {
    const minimal: Workout = { id: 'w2', date: '2026-09-29', sport: 'other', rawText: '', blocks: [], createdAt: 1, updatedAt: 2 }
    const row = SERVER_TABLES.workouts.toRow(minimal as unknown as Doc)
    expect(row).toMatchObject({ title: null, recording_id: null, recording_linked_by: null, recording_offset: null })
    expect(SERVER_TABLES.workouts.fromRow(asPostgres(row))).toEqual(minimal)
  })

  it('uses one column per field', () => {
    expect(Object.keys(SERVER_TABLES.workouts.toRow(workout as unknown as Doc)).sort()).toEqual(
      [
        'id', 'date', 'sport', 'title', 'notes', 'rpe', 'duration', 'raw_text', 'blocks', 'profile', 'speed_unit',
        'recording_id', 'recording_linked_by', 'recording_offset', 'unlinked_recording_id', 'created_at', 'updated_at',
      ].sort(),
    )
    expect(SERVER_TABLES.recordings.toRow(recording as unknown as Doc)).toMatchObject({
      strava_id: 12345678901,
      start_time: '2026-09-29T07:00:00.000Z',
      updated_at: new Date(1790000000789).toISOString(),
    })
  })
})
