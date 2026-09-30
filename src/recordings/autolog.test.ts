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

/** 1 Hz streams from [seconds, run speed m/s, ride power W] pieces. */
function streamsOf(id: string, pieces: [number, number, number][]) {
  const speed: number[] = []
  const power: number[] = []
  for (const [secs, v, w] of pieces) {
    for (let i = 0; i < secs; i++) {
      speed.push(v)
      power.push(w)
    }
  }
  speed.push(speed[speed.length - 1])
  power.push(power[power.length - 1])
  return {
    recordingId: id,
    t: Uint32Array.from(speed, (_, i) => i),
    speed: Float32Array.from(speed),
    power: Uint16Array.from(power),
  }
}

/** A steady 20-minute run (or ride at 200 W). */
const STEADY: [number, number, number][] = [[1200, 3, 200]]
/** 10 min easy, 5 × 3 min hard with 2 min easy, 10 min easy. */
const INTERVALS: [number, number, number][] = [
  [600, 3, 150],
  ...Array.from({ length: 5 }, (_, i): [number, number, number][] => (i < 4 ? [[180, 4.2, 280], [120, 2.5, 120]] : [[180, 4.2, 280]])).flat(),
  [600, 3, 150],
]

async function addRecording(r: Recording, pieces = INTERVALS) {
  await db.recordings.put(r)
  await db.recordingStreams.put(streamsOf(r.id, pieces))
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('autoLogRecordings', () => {
  it('creates a workout once per run or ride with intervals', async () => {
    await addRecording(recording('a', 'run', { name: 'Morning Run' }))
    await addRecording(recording('b', 'ride'))
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(2)
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)

    const run = await db.workouts.where('recording.id').equals('a').first()
    expect(run).toMatchObject({
      date: '2026-09-29',
      sport: 'run',
      title: 'Morning Run',
      rawText: '10m wu @ 5:33/km, 5x3m/2m -r @ 3:58/km, 10m cd @ 5:33/km',
      generated: true,
      speedUnit: 'pace',
      recording: { id: 'a', linkedBy: 'auto', alignment: { method: 'offset', offset: 0 } },
    })
    expect((await db.workouts.where('recording.id').equals('b').first())?.rawText).toMatch(/5x3m\/2m -r @ 2\d\dw/)
  })

  it('leaves steady runs and rides as unstructured activities', async () => {
    await addRecording(recording('a', 'run'), STEADY)
    await addRecording(recording('b', 'ride'), STEADY)
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect(await db.workouts.count()).toBe(0)
    expect((await db.recordings.get('a'))?.unstructured).toBeGreaterThan(0)
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

    expect(await reprocessAll()).toEqual({ updated: 1, created: 0, removed: 0 })
    expect((await db.workouts.get(a!.id))?.rawText).toBe('10m wu @ 5:33/km, 5x3m/2m -r @ 3:58/km, 10m cd @ 5:33/km')
    expect((await db.workouts.get(b!.id))?.rawText).toBe('my edit')
  })

  it('removes generated workouts that are now unstructured, but not edited ones', async () => {
    await addRecording(recording('a', 'run'), STEADY)
    await addRecording(recording('b', 'run'), STEADY)
    const link = (id: string) => ({ id, linkedBy: 'auto' as const, alignment: { method: 'offset' as const, offset: 0 } })
    await saveWorkout({ date: '2026-09-29', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks, generated: true, recording: link('a') })
    await saveWorkout({ date: '2026-09-29', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks, recording: link('b') })
    await db.recordings.update('a', { autoLogged: 1 })

    expect(await reprocessAll()).toEqual({ updated: 0, created: 0, removed: 1 })
    expect(await db.workouts.where('recording.id').equals('a').count()).toBe(0)
    expect(await db.workouts.where('recording.id').equals('b').count()).toBe(1)
    expect(await db.recordings.get('a')).toMatchObject({ unstructured: expect.any(Number) })
    expect((await db.recordings.get('a'))?.autoLogged).toBeUndefined()
  })
})
