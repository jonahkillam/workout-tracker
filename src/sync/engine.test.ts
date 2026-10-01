import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData, db, deleteWorkout, saveWorkout } from '../db/db'
import type { Workout } from '../model/types'
import { adoptOwner, pull, push, startSync, whenReady } from './engine'
import { FakeRemote } from './fakeRemote'

let server: FakeRemote

const workout = (id: string, extra: Partial<Workout> = {}): Workout => ({
  id, date: '2026-09-29', sport: 'run', rawText: '20m', blocks: [], createdAt: 1, updatedAt: 1, ...extra,
})

/** Another device: same server, empty local database. */
async function switchDevice() {
  await adoptOwner('someone-else')
  await adoptOwner('user')
}

beforeEach(async () => {
  server = new FakeRemote()
  await adoptOwner('someone-else')
  await adoptOwner('user')
})

describe('sync engine', () => {
  it('pushes local writes and empties the outbox', async () => {
    await saveWorkout({ ...workout('w1'), notes: [{ kind: 'fuel', text: 'gel' }] })
    await push(server)
    expect(await db.outbox.count()).toBe(0)
    expect(server.get('workouts', 'w1')?.doc).toMatchObject({ id: 'w1', notes: [{ kind: 'fuel', text: 'gel' }] })
    const rev = server.rev
    await push(server)
    expect(server.rev).toBe(rev)
  })

  it('pulls changes into an empty device without queueing them back', async () => {
    await saveWorkout(workout('w1'))
    await db.weekNotes.put({ weekStart: '2026-09-28', text: 'base', updatedAt: 1 })
    await push(server)
    await switchDevice()
    expect(await db.workouts.count()).toBe(0)

    await pull(server)
    expect(await db.workouts.get('w1')).toMatchObject({ id: 'w1', rawText: '20m' })
    expect(await db.weekNotes.get('2026-09-28')).toMatchObject({ text: 'base' })
    expect(await db.outbox.count()).toBe(0)
    expect((await db.syncMeta.get('sync'))?.cursor).toBe(server.rev)
  })

  it('pages through large pulls', async () => {
    for (let i = 0; i < 1203; i++) server.put('workouts', `w${i}`, { ...workout(`w${i}`) }, 1)
    await pull(server)
    expect(await db.workouts.count()).toBe(1203)
  })

  it('sends deletes as tombstones, and applies pulled ones', async () => {
    await saveWorkout(workout('w1'))
    await db.recordings.put({
      id: 'r1', startTime: '', localDate: '2026-09-29', sport: 'run', rawSport: 'Run', elapsed: 1, laps: [], updatedAt: 0,
    })
    await db.recordingStreams.put({ recordingId: 'r1', t: Uint32Array.from([0]) })
    await push(server)

    await deleteWorkout('w1')
    await push(server)
    expect(server.get('workouts', 'w1')).toMatchObject({ deleted: true, doc: null })

    server.put('recordings', 'r1', null, Date.now() + 1000)
    await pull(server)
    expect(await db.recordings.get('r1')).toBeUndefined()
    expect(await db.recordingStreams.get('r1')).toBeUndefined()
  })

  it('keeps a pending local edit over an older pulled one, then pushes it', async () => {
    server.put('workouts', 'w1', { ...workout('w1', { rawText: 'theirs' }) }, 1)
    await saveWorkout(workout('w1', { rawText: 'mine' }))
    await pull(server)
    expect((await db.workouts.get('w1'))?.rawText).toBe('mine')
    await push(server)
    expect(server.get('workouts', 'w1')?.doc).toMatchObject({ rawText: 'mine' })
  })

  it('takes the server copy when it is newer, even if the pull already passed it', async () => {
    server.put('workouts', 'w1', { ...workout('w1', { rawText: 'newer elsewhere' }) }, Date.now() + 60_000)
    await saveWorkout(workout('w1', { rawText: 'stale here' }))
    await pull(server) // skipped: pending locally
    await push(server) // rejected: the server's copy is newer
    expect((await db.workouts.get('w1'))?.rawText).toBe('newer elsewhere')
    expect(await db.outbox.count()).toBe(0)
  })

  it('wipes local data when a different user signs in', async () => {
    await saveWorkout(workout('w1'))
    await adoptOwner('user')
    expect(await db.workouts.count()).toBe(1)
    await adoptOwner('other')
    expect(await db.workouts.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
    expect(await db.syncMeta.get('sync')).toMatchObject({ owner: 'other', cursor: 0 })
  })

  describe('startSync', () => {
    beforeEach(() => {
      const events = { addEventListener: () => {}, removeEventListener: () => {} }
      vi.stubGlobal('window', events)
      vi.stubGlobal('document', { ...events, visibilityState: 'visible' })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('waits for the first pull again after signing out and back in', async () => {
      server.put('workouts', 'w1', { ...workout('w1') }, 1)
      let stop = startSync(server)
      await whenReady()
      expect(await db.workouts.count()).toBe(1)
      stop()

      // Sign-out wipes the device; signing back in (AuthGate) adopts the owner and restarts sync before the app
      // mounts, so the app's whenReady() covers the new first pull.
      await clearLocalData()
      await adoptOwner('user')
      stop = startSync(server)
      await whenReady()
      expect(await db.workouts.count()).toBe(1)
      stop()
    })
  })
})
