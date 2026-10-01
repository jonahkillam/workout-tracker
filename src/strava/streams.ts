// Recording streams are kept per device. A device that doesn't have a recording's streams yet (it was fetched on
// another device) downloads them from Strava when it shows the recording.
import { db } from '../db/db'
import type { Recording } from '../model/types'
import { fillRecordedSummaries } from '../recordings/recorded'
import { getStreams } from './api'
import { streamsFromStrava } from './map'

const loading = new Map<string, Promise<void>>()

/**
 * Makes sure the given recordings' streams are stored locally, downloading them from Strava. Recordings whose
 * details haven't been fetched yet are skipped (the week sync gets those), as are ones Strava has no streams for.
 */
export async function ensureStreams(ids: string[]) {
  if (!ids.length) return
  const have = new Set((await db.recordingStreams.bulkGet(ids)).flatMap((s) => (s ? [s.recordingId] : [])))
  const recordings = (await db.recordings.bulkGet(ids.filter((id) => !have.has(id)))).filter(
    (r): r is Recording => !!r?.detailsFetched && !r.noStreams && r.stravaId !== undefined,
  )
  await Promise.all(
    recordings.map((r) => {
      if (!loading.has(r.id)) {
        const done = load(r)
          .catch(() => undefined) // Offline, rate-limited or not connected: try again next time it's shown.
          .finally(() => loading.delete(r.id))
        loading.set(r.id, done)
      }
      return loading.get(r.id)
    }),
  )
}

async function load(r: Recording) {
  const s = streamsFromStrava(r.id, await getStreams(r.stravaId!))
  if (!s) return
  await db.recordingStreams.put(s)
  await fillRecordedSummaries([r])
}
