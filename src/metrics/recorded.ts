// Totals from what was recorded, for sessions whose recording is a better measure than the plan.
import type { Histogram, Profile, Recording, Sport, Workout } from '../model/types'
import { band, emptyTotals, HR_BOUNDS, loadFor, PACE_BOUNDS, POWER_BOUNDS, rpeZone, workoutTotals, type Totals } from './workout'

/** Seconds per zone from a histogram, with each bin zoned by its midpoint as a fraction of `threshold`. */
function histZones(h: Histogram, threshold: number, bounds: number[]): number[] {
  const zones = [0, 0, 0, 0, 0]
  h.secs.forEach((secs, i) => {
    if (secs) zones[band(((i + 0.5) * h.bin) / threshold, bounds) - 1] += secs
  })
  return zones
}

/**
 * Time in zones from the recording: GAP against threshold pace for runs, power
 * against FTP for rides, otherwise HR against LTHR. Undefined when the
 * thresholds or data for all of those are missing.
 */
function recordedZones(rec: Recording, sport: Sport, profile: Profile): number[] | undefined {
  const r = rec.recorded
  if (sport === 'run' && r?.gap && profile.thresholdSpeed) return histZones(r.gap, profile.thresholdSpeed, PACE_BOUNDS)
  if (sport === 'ride' && r?.power && profile.ftp) return histZones(r.power, profile.ftp, POWER_BOUNDS)
  if (r?.hr && profile.lthr) return histZones(r.hr, profile.lthr, HR_BOUNDS)
  return undefined
}

/**
 * Totals for a recorded session. Duration is moving time. Zones come from the
 * recording (see `recordedZones`), else the plan's zones (`planned`) stretched
 * to the recorded time, else all in the session RPE's zone or Z2.
 */
export function recordedTotals(
  rec: Recording,
  sport: Sport,
  profile: Profile,
  { rpe, planned }: { rpe?: number; planned?: Totals } = {},
): Totals {
  const t = emptyTotals()
  t.duration = rec.moving ?? rec.recorded?.moving ?? rec.elapsed
  t.distance = sport === 'stair' ? 0 : (rec.distance ?? rec.recorded?.distance ?? 0)
  t.vertical = rec.elevationGain ?? 0
  t.flatDistance = t.distance
  const gap = rec.recorded?.gap
  if (gap) {
    gap.secs.forEach((secs, i) => {
      t.gapDistance += (((i + 0.5) * gap.bin) / 3.6) * secs
      t.gapTime += secs
    })
    t.flatDistance = t.gapTime ? t.gapDistance * (t.duration / t.gapTime) : t.distance
  }
  const zones = recordedZones(rec, sport, profile) ?? (planned?.duration ? planned.zoneTime : undefined)
  const counted = zones?.reduce((a, b) => a + b, 0)
  if (zones && counted) t.zoneTime = zones.map((z) => (z / counted) * t.duration)
  else t.zoneTime[(rpe !== undefined ? rpeZone(rpe) : 2) - 1] = t.duration
  t.load = loadFor(t.zoneTime, t.duration, rpe)
  return t
}

/** Whether a workout's totals come from its recording: runs with recorded pace, rides with recorded power. */
export function usesRecording(w: Pick<Workout, 'sport'>, rec: Recording | undefined): rec is Recording {
  return (w.sport === 'run' && !!rec?.recorded?.gap) || (w.sport === 'ride' && !!rec?.recorded?.power)
}

/**
 * A workout's totals for the week: from its recording when that measures the
 * session properly (see `usesRecording`), otherwise from the plan.
 */
export function sessionTotals(
  w: Pick<Workout, 'sport' | 'blocks' | 'rpe' | 'duration' | 'profile'>,
  rec: Recording | undefined,
  fallback: Profile,
): Totals {
  const planned = workoutTotals(w, fallback)
  return usesRecording(w, rec) ? recordedTotals(rec, w.sport, w.profile ?? fallback, { rpe: w.rpe, planned }) : planned
}
