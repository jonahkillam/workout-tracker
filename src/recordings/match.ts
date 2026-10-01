// Pairing recorded activities with logged workouts. Pure functions.
import type { Recording, RecordingLink, Sport, Workout } from '../model/types'

/** A new link to a recording, with the plan starting where the recording does. */
export function newLink(id: string, linkedBy: RecordingLink['linkedBy']): RecordingLink {
  return { id, linkedBy, offset: 0 }
}

/** Watches often record treadmill runs as ordinary runs, so those two can pair up. */
function sportsCompatible(workout: Sport, recording: Sport): boolean {
  if (workout === recording) return true
  const running = new Set<Sport>(['run', 'treadmill'])
  return running.has(workout) && running.has(recording)
}

interface Candidate {
  workoutId: string
  recordingId: string
  /** Seconds between the planned and recorded duration; lower is better. */
  score: number
}

/** A best candidate is clear if it's the only one, or much closer than the runner-up. */
function clearBest(list: Candidate[]): Candidate | undefined {
  const sorted = [...list].sort((a, b) => a.score - b.score)
  if (sorted.length === 1) return sorted[0]
  if (sorted.length > 1 && sorted[0].score * 2 < sorted[1].score) return sorted[0]
  return undefined
}

/**
 * Workout–recording pairs to link automatically: same date, compatible sport,
 * and each is the other's clear best match by duration. Workouts that already
 * have a recording, recordings already linked, and pairs the user unlinked are
 * left alone.
 *
 * `durationOf` gives a workout's planned duration in seconds (0 if unknown).
 */
export function autoLinks(
  workouts: Workout[],
  recordings: Recording[],
  durationOf: (w: Workout) => number,
): { workoutId: string; recordingId: string }[] {
  const taken = new Set(workouts.map((w) => w.recording?.id).filter(Boolean))
  const free = recordings.filter((r) => !taken.has(r.id))
  const candidates: Candidate[] = []
  for (const w of workouts) {
    if (w.recording) continue
    const planned = durationOf(w)
    for (const r of free) {
      if (r.localDate !== w.date || r.id === w.unlinked || !sportsCompatible(w.sport, r.sport)) continue
      candidates.push({ workoutId: w.id, recordingId: r.id, score: planned ? Math.abs(planned - r.elapsed) : 0 })
    }
  }
  const links: { workoutId: string; recordingId: string }[] = []
  for (const w of new Set(candidates.map((c) => c.workoutId))) {
    const best = clearBest(candidates.filter((c) => c.workoutId === w))
    if (!best) continue
    const reverse = clearBest(candidates.filter((c) => c.recordingId === best.recordingId))
    if (reverse?.workoutId === w) links.push({ workoutId: w, recordingId: best.recordingId })
  }
  return links
}
