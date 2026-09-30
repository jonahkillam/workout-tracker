import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, saveWorkout } from '../db/db'
import { parseWorkout } from '../parser/parser'
import { forgetStravaToken } from './auth'
import { syncWeek } from './sync'

vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } },
}))

const WEEK = '2026-09-28'
const NOW = new Date(2026, 8, 30, 12).getTime()

const activity = (id: number, local: string, sport: string, elapsed: number, extra = {}) => ({
  id,
  name: `Activity ${id}`,
  sport_type: sport,
  start_date: `${local}:00Z`,
  start_date_local: `${local}:00Z`,
  elapsed_time: elapsed,
  average_heartrate: 150,
  ...extra,
})

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>
let routes: Record<string, Route>
let calls: string[]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'x-readratelimit-usage': '3,10', 'x-readratelimit-limit': '100,1000' } })

beforeEach(async () => {
  // Token expiry reads the clock; fake only Date so IndexedDB timers still run.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await Promise.all(db.tables.map((t) => t.clear()))
  await db.stravaConnection.put({ id: 'strava', athleteId: 1, athleteName: 'Test', scope: 'read,activity:read_all' })
  forgetStravaToken()
  calls = []
  routes = {
    '/api/strava/token': () => json({ access_token: 'tok', expires_at: NOW / 1000 + 3600 }),
    '/athlete/activities': () => json([
      activity(1, '2026-09-29T07:00', 'Run', 3000, { trainer: true }),
      activity(2, '2026-09-30T18:00', 'StairStepper', 1800),
      activity(3, '2026-10-06T07:00', 'Run', 3000), // next week: filtered out
    ]),
    '/activities/1/streams': () => json({ time: { data: [0, 1, 2] }, heartrate: { data: [140, 141, 142] } }),
    '/activities/1/laps': () => json([{ start_index: 0, elapsed_time: 3000 }]),
    '/activities/2/streams': () => json({ message: 'Record Not Found' }, 404),
    '/activities/2/laps': () => json([]),
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const path = url.pathname.replace('/api/v3', '')
    calls.push(path)
    const route = routes[path]
    return route ? route(url, init) : json({ message: 'not found' }, 404)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('syncWeek', () => {
  it('stores the week\'s activities, their streams and laps, and auto-links', async () => {
    const w = await saveWorkout({ date: '2026-09-29', sport: 'treadmill', rawText: '50m', blocks: parseWorkout('50m').blocks })
    const result = await syncWeek(WEEK, { now: NOW })
    expect(result).toEqual({ status: 'synced', activities: 2, linked: 1 })

    const recs = await db.recordings.orderBy('startTime').toArray()
    expect(recs.map((r) => [r.id, r.stravaId, r.sport, r.localDate])).toEqual([
      ['strava-1', 1, 'treadmill', '2026-09-29'],
      ['strava-2', 2, 'stair', '2026-09-30'],
    ])
    expect(recs[0].laps).toEqual([{ start: 0, duration: 3000, distance: undefined }])
    expect((await db.recordingStreams.get(recs[0].id))?.hr).toEqual(Uint8Array.from([140, 141, 142]))
    expect(recs[1].streamsFrom).toBe('strava') // 404 streams: marked so it isn't refetched
    expect((await db.workouts.get(w.id))?.recording).toMatchObject({ id: recs[0].id, linkedBy: 'auto' })
  })

  it('skips the network when the week is fresh, and refetches only summaries later', async () => {
    await syncWeek(WEEK, { now: NOW })
    calls = []
    expect((await syncWeek(WEEK, { now: NOW + 60_000 })).status).toBe('fresh')
    expect(calls).toEqual([])
    await syncWeek(WEEK, { now: NOW + 60_000, force: true })
    expect(calls).toEqual(['/athlete/activities']) // streams already stored
  })

  it('merges with an existing recording of the same activity and drops deleted ones', async () => {
    await db.recordings.put({
      id: 'fit-1', fitHash: 'abc', startTime: '2026-09-29T07:00:20Z', localDate: '2026-09-29', sport: 'run',
      rawSport: 'running', elapsed: 3000, laps: [], importedAt: 0, updatedAt: 0, streamsFrom: 'fit',
    })
    await syncWeek(WEEK, { now: NOW })
    expect((await db.recordings.get('fit-1'))?.stravaId).toBe(1)
    expect(await db.recordings.count()).toBe(2)

    routes['/athlete/activities'] = () => json([activity(1, '2026-09-29T07:00', 'Run', 3000)])
    await syncWeek(WEEK, { now: NOW, force: true })
    expect(await db.recordings.where('stravaId').equals(2).count()).toBe(0)
  })

  it('gets an access token from the server once, and asks again when it is about to expire', async () => {
    const auth: string[] = []
    routes['/athlete/activities'] = (_url, init) => {
      auth.push(new Headers(init?.headers).get('authorization') ?? '')
      return json([])
    }
    await syncWeek(WEEK, { now: NOW, force: true })
    await syncWeek(WEEK, { now: NOW, force: true })
    expect(calls.filter((c) => c === '/api/strava/token')).toHaveLength(1)
    expect(auth).toEqual(['Bearer tok', 'Bearer tok'])

    routes['/api/strava/token'] = () => json({ access_token: 'tok2', expires_at: NOW / 1000 + 7200 })
    vi.setSystemTime(NOW + 3600_000)
    await syncWeek(WEEK, { now: NOW, force: true })
    expect(auth.at(-1)).toBe('Bearer tok2')
  })

  it('shows Strava as disconnected when the server no longer has access', async () => {
    routes['/api/strava/token'] = () => json({ error: 'Strava access was revoked; connect again' }, 410)
    await expect(syncWeek(WEEK, { now: NOW })).rejects.toThrow('Strava is not connected')
    expect(await db.stravaConnection.get('strava')).toBeUndefined()
  })

  it('stops on the rate limit without marking the week as fetched', async () => {
    routes['/activities/1/streams'] = () => new Response('{}', { status: 429 })
    expect((await syncWeek(WEEK, { now: NOW })).status).toBe('rate-limited')
    expect(await db.stravaWeekFetch.get(WEEK)).toBeUndefined()
    expect(await db.recordings.count()).toBe(2)
  })

  it('does nothing when not connected', async () => {
    await db.stravaConnection.clear()
    expect((await syncWeek(WEEK, { now: NOW })).status).toBe('not-connected')
    expect(calls).toEqual([])
  })

  it('skips future weeks, even when forced', async () => {
    expect(await syncWeek('2026-10-05', { now: NOW, force: true })).toEqual({ status: 'future', activities: 0, linked: 0 })
    expect(calls).toEqual([])
    expect(await db.stravaWeekFetch.get('2026-10-05')).toBeUndefined()
  })
})
