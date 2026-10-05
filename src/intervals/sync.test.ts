import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, deleteWorkout, saveWorkout } from '../db/db'
import type { IntervalsEvent } from '../export/intervals'
import { parseWorkout } from '../parser/parser'
import { newLink } from '../recordings/match'
import type { IntervalsApi, RemoteEvent } from './api'
import { reconcile } from './sync'

const TODAY = '2026-10-01'

/** An in-memory intervals.icu calendar that counts its writes. */
class FakeCalendar implements IntervalsApi {
  events: RemoteEvent[] = []
  writes = 0
  nextId = 1
  async list(oldest: string, newest: string) {
    return this.events.filter((e) => e.start_date_local!.slice(0, 10) >= oldest && e.start_date_local!.slice(0, 10) <= newest)
  }
  async create(events: IntervalsEvent[]) {
    this.writes++
    for (const e of events) this.events.push({ ...e, id: this.nextId++ })
  }
  async update(id: number, event: IntervalsEvent) {
    this.writes++
    this.events = this.events.map((e) => (e.id === id ? { ...event, id } : e))
  }
  async remove(ids: number[]) {
    this.writes++
    this.events = this.events.filter((e) => !ids.includes(e.id))
  }
}

const plan = (id: string, date: string, text = '5x3m/2m @ Z4') =>
  saveWorkout({ id, date, sport: 'run', rawText: text, blocks: parseWorkout(text).blocks })

let calendar: FakeCalendar

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  calendar = new FakeCalendar()
})

describe('intervals.icu reconcile', () => {
  it('creates events for planned workouts from today on, once', async () => {
    await plan('w1', '2026-10-06')
    await plan('past', '2026-09-20')
    await saveWorkout({ ...(await plan('done', '2026-10-01')), recording: newLink('strava-1', 'auto') })
    expect(await reconcile(calendar, TODAY)).toEqual({ created: 1, updated: 0, removed: 0 })
    expect(calendar.events).toMatchObject([{ external_id: 'workout-tracker:w1', start_date_local: '2026-10-06T00:00:00' }])

    await reconcile(calendar, TODAY)
    expect(calendar.writes).toBe(1)
  })

  it('updates an event when its workout changes or moves, also to an earlier date', async () => {
    const w = await plan('w1', '2026-10-06')
    await reconcile(calendar, TODAY)
    await saveWorkout({ ...w, date: '2026-10-08', rawText: '40m', blocks: parseWorkout('40m').blocks })
    expect(await reconcile(calendar, TODAY)).toEqual({ created: 0, updated: 1, removed: 0 })
    expect(calendar.events).toMatchObject([{ id: 1, start_date_local: '2026-10-08T00:00:00', description: '- 40m Z2 HR' }])

    await saveWorkout({ ...w, date: '2026-09-29' })
    await reconcile(calendar, TODAY)
    expect(calendar.events).toMatchObject([{ id: 1, start_date_local: '2026-09-29T00:00:00' }])
  })

  it('deletes the event of a deleted workout, and leaves events it did not create', async () => {
    await plan('w1', '2026-10-06')
    await reconcile(calendar, TODAY)
    calendar.events.push({ id: 99, category: 'WORKOUT', start_date_local: '2026-10-07T00:00:00', name: 'Coach', external_id: 'other-app:1' })
    calendar.events.push({ id: 98, category: 'WORKOUT', start_date_local: '2026-10-07T00:00:00', name: 'Mine' })
    await deleteWorkout('w1')
    expect(await reconcile(calendar, TODAY)).toEqual({ created: 0, updated: 0, removed: 1 })
    expect(calendar.events.map((e) => e.id)).toEqual([99, 98])
  })

  it('leaves the event of a workout that now has its recording', async () => {
    const w = await plan('w1', TODAY)
    await reconcile(calendar, TODAY)
    await saveWorkout({ ...w, title: 'Done', recording: newLink('strava-1', 'auto') })
    expect(await reconcile(calendar, TODAY)).toEqual({ created: 0, updated: 0, removed: 0 })
    expect(calendar.events).toHaveLength(1)
  })

  it('drops a duplicate event for the same workout', async () => {
    await plan('w1', '2026-10-06')
    await reconcile(calendar, TODAY)
    calendar.events.push({ ...calendar.events[0], id: 2 })
    expect(await reconcile(calendar, TODAY)).toEqual({ created: 0, updated: 0, removed: 1 })
    expect(calendar.events.map((e) => e.id)).toEqual([1])
  })
})
