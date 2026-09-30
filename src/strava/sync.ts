// Pulls a week's Strava activities into recordings and links them to workouts.
import { db, loadSettings } from '../db/db'
import { addDays, toISO, weekDays } from '../metrics/dates'
import { workoutTotals } from '../metrics/workout'
import type { Recording } from '../model/types'
import { autoLogRecordings } from '../recordings/autolog'
import { autoLinks, findSameActivity } from '../recordings/match'
import { fillRecordedSummaries } from '../recordings/recorded'
import { getLaps, getStreams, listActivities, RateLimitedError } from './api'
import { lapsFromStrava, recordingFromSummary, streamsFromStrava } from './map'

export interface SyncResult {
  status: 'synced' | 'fresh' | 'not-connected' | 'rate-limited' | 'future'
  /** Activities found in the week. */
  activities: number
  linked: number
}

const FRESH_CURRENT_WEEK = 15 * 60 * 1000
const FRESH_PAST_WEEK = 24 * 60 * 60 * 1000

function epochSeconds(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000)
}

/** Fetches streams and laps for recordings that don't have them yet, two at a time. */
async function fetchDetails(recordings: Recording[]) {
  const queue = recordings.filter((r) => r.stravaId !== undefined && !r.streamsFrom)
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const [streams, laps] = await Promise.all([getStreams(r.stravaId!), getLaps(r.stravaId!)])
      const rows = streamsFromStrava(r.id, streams)
      await db.transaction('rw', db.recordings, db.recordingStreams, async () => {
        if (rows) await db.recordingStreams.put(rows)
        // Marked even without streams, so manual activities aren't refetched every time.
        await db.recordings.update(r.id, { streamsFrom: 'strava', laps: lapsFromStrava(laps, rows?.t), updatedAt: Date.now() })
      })
    }
  }
  await Promise.all([worker(), worker()])
}

/** Links unlinked workouts in the week to their clear-best recording. */
async function linkWeek(days: string[]): Promise<number> {
  const settings = await loadSettings()
  const workouts = await db.workouts.where('date').anyOf(days).toArray()
  const recordings = await db.recordings.where('localDate').anyOf(days).toArray()
  const links = autoLinks(workouts, recordings, (w) => workoutTotals(w, w.profile ?? settings).duration)
  const now = Date.now()
  for (const l of links) {
    await db.workouts
      .where('id')
      .equals(l.workoutId)
      .modify((w) => {
        w.recording = { id: l.recordingId, linkedBy: 'auto', alignment: { method: 'offset', offset: 0 } }
        w.updatedAt = now
      })
  }
  return links.length
}

/**
 * Syncs one week (Monday `weekStart`) from Strava. Skips the network if the week
 * was fetched recently, unless `force` is set.
 */
export async function syncWeek(weekStart: string, { force = false, now = Date.now() } = {}): Promise<SyncResult> {
  if (!(await db.stravaAuth.get('strava'))) return { status: 'not-connected', activities: 0, linked: 0 }
  // Strava rejects a future `after` bound, and there's nothing to fetch anyway.
  if (weekStart > toISO(new Date(now))) return { status: 'future', activities: 0, linked: 0 }
  const days = weekDays(weekStart)
  const last = await db.stravaWeekFetch.get(weekStart)
  const freshFor = days.includes(toISO(new Date(now))) ? FRESH_CURRENT_WEEK : FRESH_PAST_WEEK
  if (!force && last && now - last.fetchedAt < freshFor) {
    return { status: 'fresh', activities: await db.recordings.where('localDate').anyOf(days).count(), linked: 0 }
  }

  try {
    // Pad the window by a day each side: Strava filters on UTC start time.
    const activities = (await listActivities(epochSeconds(addDays(weekStart, -1)), epochSeconds(addDays(weekStart, 8))))
      .filter((a) => days.includes(a.start_date_local.slice(0, 10)))

    await db.transaction('rw', db.recordings, db.recordingStreams, db.workouts, async () => {
      const inWeek = await db.recordings.where('localDate').anyOf(days).toArray()
      const seen = new Set<number>()
      for (const a of activities) {
        seen.add(a.id)
        const existing =
          inWeek.find((r) => r.stravaId === a.id) ??
          findSameActivity(inWeek.filter((r) => r.stravaId === undefined), a.start_date)
        await db.recordings.put(recordingFromSummary(a, existing, now))
      }
      // Activities deleted on Strava: drop them and any links to them.
      const gone = inWeek.filter((r) => r.stravaId !== undefined && !seen.has(r.stravaId) && !r.fitHash)
      for (const r of gone) {
        await db.recordings.delete(r.id)
        await db.recordingStreams.delete(r.id)
        await db.workouts.where('recording.id').equals(r.id).modify((w) => void delete w.recording)
      }
    })

    await fetchDetails(await db.recordings.where('localDate').anyOf(days).toArray())
    await fillRecordedSummaries(await db.recordings.where('localDate').anyOf(days).toArray())
    const linked = await linkWeek(days)
    // After linking, so planned workouts take their recordings first.
    await autoLogRecordings(await db.recordings.where('localDate').anyOf(days).toArray())
    await db.stravaWeekFetch.put({ weekStart, fetchedAt: now })
    return { status: 'synced', activities: activities.length, linked }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Link what we have; the week is retried on the next visit.
      await fillRecordedSummaries(await db.recordings.where('localDate').anyOf(days).toArray())
      const linked = await linkWeek(days)
      await autoLogRecordings(await db.recordings.where('localDate').anyOf(days).toArray())
      return { status: 'rate-limited', activities: await db.recordings.where('localDate').anyOf(days).count(), linked }
    }
    throw e
  }
}
