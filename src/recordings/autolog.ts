// Turns unlinked runs and rides into logged workouts, with their structure detected from the recording.
import { db, loadSettings } from '../db/db'
import { profileOf, type Block, type Profile, type Recording, type RecordingStreams, type Settings, type Workout } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { serializeBlocks } from '../parser/serialize'
import { detectBlocks } from './intervals'

/** Detected structure as shorthand, with the blocks re-parsed from it so text stays the source of truth. */
export function detectText(
  rec: Recording,
  streams: RecordingStreams | undefined,
  profile: Profile,
): { rawText: string; blocks: Block[] } | undefined {
  const detected = detectBlocks(rec, streams, profile)
  if (!detected) return undefined
  const rawText = serializeBlocks(detected)
  return { rawText, blocks: parseWorkout(rawText, { speedUnit: 'pace' }).blocks }
}

function workoutFor(rec: Recording, detected: { rawText: string; blocks: Block[] }, settings: Settings): Workout {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    date: rec.localDate,
    sport: rec.sport,
    title: rec.name,
    ...detected,
    generated: true,
    profile: profileOf(settings),
    speedUnit: rec.sport === 'run' ? 'pace' : settings.speedUnit,
    recording: { id: rec.id, linkedBy: 'auto', alignment: { method: 'offset', offset: 0 } },
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Creates a workout for each run or ride with no workout linked to it. Each
 * recording is only ever logged once, so deleting the workout keeps it deleted.
 * Returns how many were created.
 */
export async function autoLogRecordings(recordings: Recording[]): Promise<number> {
  const settings = await loadSettings()
  const profile = profileOf(settings)
  let created = 0
  for (const r of recordings) {
    if (r.autoLogged || !r.streamsFrom || (r.sport !== 'run' && r.sport !== 'ride')) continue
    const streams = await db.recordingStreams.get(r.id)
    const detected = detectText(r, streams, profile)
    if (!detected) continue
    // Re-checked in the transaction so overlapping passes (startup and sync) can't both log it.
    const made = await db.transaction('rw', db.workouts, db.recordings, async () => {
      const fresh = await db.recordings.get(r.id)
      if (!fresh || fresh.autoLogged) return false
      if (await db.workouts.where('recording.id').equals(r.id).count()) return false
      await db.workouts.put(workoutFor(fresh, detected, settings))
      await db.recordings.update(r.id, { autoLogged: Date.now() })
      return true
    })
    if (made) created++
  }
  return created
}

/**
 * Re-runs detection on every generated workout that hasn't been edited by hand,
 * then logs any recordings not logged yet. For trying out changes to detection.
 */
export async function reprocessAll(): Promise<{ updated: number; created: number }> {
  const settings = await loadSettings()
  const generated = (await db.workouts.toArray()).filter((w) => w.generated && w.recording)
  let updated = 0
  for (const w of generated) {
    const [rec, streams] = await Promise.all([db.recordings.get(w.recording!.id), db.recordingStreams.get(w.recording!.id)])
    const detected = rec && detectText(rec, streams, w.profile ?? profileOf(settings))
    if (!detected) continue
    if (detected.rawText !== w.rawText) {
      await db.workouts
        .where('id')
        .equals(w.id)
        .modify((row) => {
          row.rawText = detected.rawText
          row.blocks = detected.blocks
          row.updatedAt = Date.now()
        })
      updated++
    }
  }
  const created = await autoLogRecordings(await db.recordings.toArray())
  return { updated, created }
}
