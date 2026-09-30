import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, saveWorkout } from '../db/db'
import type { Recording, Sport } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { autoLogRecordings, reprocessAll } from './autolog'

function recording(id: string, sport: Sport, extra: Partial<Recording> = {}): Recording {
  return {
    id,
    startTime: '2026-09-29T07:00:00Z',
    localDate: '2026-09-29',
    sport,
    rawSport: 'Run',
    elapsed: 1200,
    laps: [],
    streamsFrom: 'strava',
    importedAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

/** A steady 20-minute run (or ride at 200 W). */
async function addRecording(r: Recording) {
  await db.recordings.put(r)
  const t = Uint32Array.from({ length: 1201 }, (_, i) => i)
  await db.recordingStreams.put({
    recordingId: r.id,
    t,
    speed: Float32Array.from(t, () => 3),
    power: Uint16Array.from(t, () => 200),
  })
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('autoLogRecordings', () => {
  it('creates a workout once per run or ride', async () => {
    await addRecording(recording('a', 'run', { name: 'Morning Run' }))
    await addRecording(recording('b', 'ride'))
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(2)
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)

    const run = await db.workouts.where('recording.id').equals('a').first()
    expect(run).toMatchObject({
      date: '2026-09-29',
      sport: 'run',
      title: 'Morning Run',
      rawText: '20m @ 5:33/km',
      generated: true,
      speedUnit: 'pace',
      recording: { id: 'a', linkedBy: 'auto', alignment: { method: 'offset', offset: 0 } },
    })
    expect((await db.workouts.where('recording.id').equals('b').first())?.rawText).toBe('20m @ 200w')
  })

  it('skips recordings already linked to a workout', async () => {
    await addRecording(recording('a', 'run'))
    await saveWorkout({
      date: '2026-09-29', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks,
      recording: { id: 'a', linkedBy: 'auto', alignment: { method: 'offset', offset: 0 } },
    })
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect(await db.workouts.count()).toBe(1)
  })

  it("doesn't recreate a deleted workout", async () => {
    await addRecording(recording('a', 'run'))
    await autoLogRecordings(await db.recordings.toArray())
    await db.workouts.clear()
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect((await reprocessAll()).created).toBe(0)
  })

  it('skips treadmill and stair recordings, and ones without streams', async () => {
    await addRecording(recording('a', 'treadmill'))
    await addRecording(recording('b', 'stair'))
    await db.recordings.put(recording('c', 'run'))
    await db.recordings.put(recording('d', 'run', { streamsFrom: undefined }))
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
  })
})

describe('reprocessAll', () => {
  it('rewrites generated workouts and leaves edited ones alone', async () => {
    await addRecording(recording('a', 'run'))
    await addRecording(recording('b', 'run'))
    await autoLogRecordings(await db.recordings.toArray())
    const [a, b] = await Promise.all(['a', 'b'].map((id) => db.workouts.where('recording.id').equals(id).first()))
    await db.workouts.put({ ...a!, rawText: 'stale', blocks: [] })
    await db.workouts.put({ ...b!, rawText: 'my edit', blocks: [], generated: undefined })

    expect(await reprocessAll()).toEqual({ updated: 1, created: 0 })
    expect((await db.workouts.get(a!.id))?.rawText).toBe('20m @ 5:33/km')
    expect((await db.workouts.get(b!.id))?.rawText).toBe('my edit')
  })
})
