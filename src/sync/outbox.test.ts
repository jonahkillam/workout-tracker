import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearLocalData, db, deleteWorkout, saveSettings, saveWeekNote, saveWorkout } from '../db/db'
import { DEFAULT_SETTINGS, type Recording } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { withoutOutbox } from './outbox'

const pending = async () => (await db.outbox.toArray()).map((e) => `${e.table}:${e.key}`).sort()

const recording = (id: string): Recording => ({
  id, startTime: '2026-09-29T07:00:00Z', localDate: '2026-09-29', sport: 'run', rawSport: 'Run', elapsed: 600,
  laps: [], updatedAt: 0,
})

beforeEach(async () => {
  await clearLocalData()
})

describe('outbox', () => {
  it('records puts, updates, modifies and deletes on synced tables', async () => {
    const w = await saveWorkout({ id: 'w1', date: '2026-09-29', sport: 'run', rawText: '20m', blocks: parseWorkout('20m').blocks })
    await saveWeekNote('2026-09-28', 'easy week')
    await db.recordings.put(recording('r1'))
    expect(await pending()).toEqual(['recordings:r1', 'weekNotes:2026-09-28', 'workouts:w1'])

    await db.outbox.clear()
    await db.recordings.update('r1', { unstructured: true })
    await db.workouts.where('id').equals(w.id).modify((x) => void delete x.recording)
    expect(await pending()).toEqual(['recordings:r1', 'workouts:w1'])

    await db.outbox.clear()
    await deleteWorkout(w.id)
    expect(await pending()).toEqual(['workouts:w1'])
  })

  it('records every key a clear() removes', async () => {
    await db.recordings.bulkPut([recording('a'), recording('b')])
    await db.outbox.clear()
    await db.recordings.clear()
    expect(await pending()).toEqual(['recordings:a', 'recordings:b'])
  })

  it('coalesces repeated writes to one entry with the latest time', async () => {
    await db.recordings.put(recording('a'))
    const first = (await db.outbox.toArray())[0].ts
    await new Promise((r) => setTimeout(r, 5))
    await db.recordings.update('a', { name: 'x' })
    const entries = await db.outbox.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].ts).toBeGreaterThan(first)
  })

  it('ignores local-only tables, remote writes, and settings saves that change nothing', async () => {
    await db.recordingStreams.put({ recordingId: 'a', t: Uint32Array.from([0, 1]) })
    await db.stravaWeekFetch.put({ weekStart: '2026-09-28', fetchedAt: 1 })
    await withoutOutbox(db, ['workouts'], () =>
      db.workouts.put({ id: 'w', date: '2026-09-29', sport: 'run', rawText: '', blocks: [], createdAt: 0, updatedAt: 0 }),
    )
    expect(await pending()).toEqual([])

    await saveSettings({ ...DEFAULT_SETTINGS })
    expect(await pending()).toEqual(['settings:settings', 'workouts:w'])
    await db.outbox.clear()
    await saveSettings({ ...DEFAULT_SETTINGS })
    expect(await pending()).toEqual(['settings:settings'])
  })

  it('writes the entry in the same transaction, so an aborted write leaves none', async () => {
    await expect(
      db.transaction('rw', db.recordings, async () => {
        await db.recordings.put(recording('a'))
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(await pending()).toEqual([])
  })
})
