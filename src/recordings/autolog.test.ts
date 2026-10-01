import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, saveSettings, saveWorkout } from '../db/db'
import { DEFAULT_SETTINGS, profileOf, type Recording, type Sport } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { autoLogRecordings } from './autolog'
import { newLink } from './match'

function recording(id: string, sport: Sport, extra: Partial<Recording> = {}): Recording {
  return {
    id,
    startTime: '2026-09-29T07:00:00Z',
    localDate: '2026-09-29',
    sport,
    rawSport: 'Run',
    elapsed: 1200,
    laps: [],
    detailsFetched: true,
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
      id: 'auto-a',
      date: '2026-09-29',
      sport: 'run',
      title: 'Morning Run',
      rawText: '10m wu @ 5:33/km, 5x3m/2m -r @ 3:58/km, 10m cd @ 5:33/km',
      speedUnit: 'pace',
      recording: { id: 'a', linkedBy: 'auto', offset: 0 },
    })
    expect((await db.workouts.where('recording.id').equals('b').first())?.rawText).toMatch(/5x3m\/2m -r @ 2\d\dw/)
  })

  it('leaves steady runs and rides as unstructured activities', async () => {
    await addRecording(recording('a', 'run'), STEADY)
    await addRecording(recording('b', 'ride'), STEADY)
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect(await db.workouts.count()).toBe(0)
    expect((await db.recordings.get('a'))?.unstructured).toBe(true)
  })

  it('skips recordings already linked to a workout, on any day, without loading their streams', async () => {
    await addRecording(recording('a', 'run'))
    await saveWorkout({ date: '2026-09-27', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks, recording: newLink('a', 'manual') })
    const get = vi.spyOn(db.recordingStreams, 'get')
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect(get).not.toHaveBeenCalled()
    get.mockRestore()
    expect(await db.workouts.count()).toBe(1)
    expect((await db.recordings.get('a'))?.unstructured).toBeUndefined()
  })

  it('skips a recording the user unlinked from a workout that day', async () => {
    await addRecording(recording('a', 'run'))
    await saveWorkout({ date: '2026-09-29', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks, unlinked: 'a' })
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
    expect(await db.workouts.count()).toBe(1)
  })

  it("zones the workout with the recording's thresholds rather than the current settings", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, thresholdSpeed: 20 })
    const then = profileOf({ ...DEFAULT_SETTINGS, thresholdSpeed: 14 })
    await addRecording(recording('a', 'run', { profile: then }))
    await autoLogRecordings(await db.recordings.toArray())
    expect((await db.workouts.get('auto-a'))?.profile).toEqual(then)
  })

  it("doesn't recreate a deleted workout", async () => {
    await addRecording(recording('a', 'run'))
    await autoLogRecordings(await db.recordings.toArray())
    await db.workouts.clear()
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
  })

  it('skips treadmill and stair recordings, and ones without streams', async () => {
    await addRecording(recording('a', 'treadmill'))
    await addRecording(recording('b', 'stair'))
    await db.recordings.put(recording('c', 'run'))
    await db.recordings.put(recording('d', 'run', { detailsFetched: undefined }))
    expect(await autoLogRecordings(await db.recordings.toArray())).toBe(0)
  })
})
