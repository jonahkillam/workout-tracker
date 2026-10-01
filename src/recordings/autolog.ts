// Turns unlinked runs and rides that clearly look like workouts into logged workouts, with their structure
// detected from the recording. The rest stay unstructured activities.
import { db, loadSettings } from '../db/db'
import { profileOf, type Block, type Profile, type Recording, type RecordingStreams, type Settings, type Workout } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { serializeBlocks } from '../parser/serialize'
import { detectBlocks } from './intervals'
import { newLink } from './match'

interface DetectedText {
  rawText: string
  blocks: Block[]
  /** Whether it clearly looks like a workout; otherwise it's steady stretches between pauses. */
  structured: boolean
}

/** Detected structure as shorthand, with the blocks re-parsed from it so text stays the source of truth. */
export function detectText(rec: Recording, streams: RecordingStreams | undefined, profile: Profile): DetectedText | undefined {
  const detected = detectBlocks(rec, streams, profile)
  if (!detected) return undefined
  const rawText = serializeBlocks(detected.blocks)
  return { rawText, blocks: parseWorkout(rawText, { speedUnit: 'pace' }).blocks, structured: detected.structured }
}

function workoutFor(rec: Recording, detected: DetectedText, profile: Profile, settings: Settings): Workout {
  const now = Date.now()
  return {
    // One per recording, so devices auto-logging the same recording converge on one workout.
    id: `auto-${rec.id}`,
    date: rec.localDate,
    sport: rec.sport,
    title: rec.name,
    rawText: detected.rawText,
    blocks: detected.blocks,
    profile,
    speedUnit: rec.sport === 'run' ? 'pace' : settings.speedUnit,
    recording: newLink(rec.id, 'auto'),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Creates a workout for each run or ride with no workout linked to it that
 * clearly looks like a workout; the rest are marked unstructured. Each
 * recording is only ever checked once and logged once, so deleting the workout
 * keeps it deleted. Returns how many were created.
 */
export async function autoLogRecordings(recordings: Recording[]): Promise<number> {
  const candidates = recordings.filter(
    (r) => !r.autoLogged && !r.unstructured && r.detailsFetched && (r.sport === 'run' || r.sport === 'ride'),
  )
  if (!candidates.length) return 0
  // Linked recordings, and ones the user unlinked from a workout that day, are left alone. Checked before
  // loading streams, as detection is the costly part.
  const linked = await db.workouts.where('recording.id').anyOf(candidates.map((r) => r.id)).toArray()
  const sameDay = await db.workouts.where('date').anyOf([...new Set(candidates.map((r) => r.localDate))]).toArray()
  const taken = new Set([...linked.map((w) => w.recording?.id), ...sameDay.map((w) => w.unlinked)])
  const todo = candidates.filter((r) => !taken.has(r.id))
  if (!todo.length) return 0
  const settings = await loadSettings()
  let created = 0
  for (const r of todo) {
    const streams = await db.recordingStreams.get(r.id)
    // Zoned with the thresholds of the time, if the recording has them.
    const profile = r.profile ?? profileOf(settings)
    const detected = detectText(r, streams, profile)
    if (!detected) continue
    if (!detected.structured) {
      await db.recordings.update(r.id, { unstructured: true })
      continue
    }
    // Re-checked in the transaction so overlapping passes (startup and sync) can't both log it.
    const made = await db.transaction('rw', db.workouts, db.recordings, async () => {
      const fresh = await db.recordings.get(r.id)
      if (!fresh || fresh.autoLogged) return false
      if (await db.workouts.where('recording.id').equals(r.id).count()) return false
      await db.workouts.put(workoutFor(fresh, detected, profile, settings))
      await db.recordings.update(r.id, { autoLogged: true })
      return true
    })
    if (made) created++
  }
  return created
}
