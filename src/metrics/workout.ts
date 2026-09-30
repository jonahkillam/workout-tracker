import { expand } from '../model/tree'
import type { Profile, Sport, Step, Workout } from '../model/types'
import { mid } from '../parser/format'

export interface Totals {
  /** Seconds. */
  duration: number
  /** Metres covered (belt/road distance). Zero for stair sessions. */
  distance: number
  /** Metres climbed. */
  vertical: number
  /** Flat-equivalent running distance from the Minetti energy cost model. */
  flatDistance: number
  /** Flat-equivalent metres and seconds over steps with both known; their ratio is average GAP. */
  gapDistance: number
  gapTime: number
  /** Seconds in Z1..Z5 (index 0..4). */
  zoneTime: number[]
  load: number
  /** Leaf steps whose duration couldn't be determined (e.g. distance with no speed). */
  unknownDuration: number
}

export interface StepStats {
  duration?: number
  distance?: number
  vertical: number
  flatDistance?: number
  /** Grade-adjusted (flat-equivalent) speed, km/h, for running steps with a speed. */
  gapSpeed?: number
  zone: number
}

/** Metabolic cost of running on a grade, J/kg/m (Minetti et al. 2002). */
export function minettiCost(grade: number): number {
  const g = Math.max(-0.45, Math.min(0.45, grade))
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6
}

/** How much harder than flat running a grade is, as a distance/speed multiplier. */
export function flatEquivalentRatio(grade: number): number {
  return minettiCost(grade) / minettiCost(0)
}

/** Speed on the flat that costs the same energy as `speed` km/h on `grade` (GAP, as km/h). */
export function gradeAdjustedSpeed(speed: number, grade: number): number {
  return speed * flatEquivalentRatio(grade)
}

/** Inverse of `gradeAdjustedSpeed`: speed on `grade` equivalent to `flatSpeed` km/h on the flat. */
export function speedForGap(flatSpeed: number, grade: number): number {
  return flatSpeed / flatEquivalentRatio(grade)
}

/** Average grade-adjusted speed over the parts of a workout with known distance, km/h. */
export function averageGap(t: Totals): number | undefined {
  return t.gapTime > 0 && t.gapDistance > 0 ? (t.gapDistance / t.gapTime) * 3.6 : undefined
}

/** Vertical rise for a distance travelled along a slope of `grade` (rise/run). */
export function verticalGain(distance: number, grade: number): number {
  return grade > 0 ? (distance * grade) / Math.sqrt(1 + grade * grade) : 0
}

function band(ratio: number, bounds: number[]): number {
  const i = bounds.findIndex((b) => ratio < b)
  return i === -1 ? 5 : i + 1
}

export function rpeZone(rpe: number): number {
  return band(rpe, [3.5, 5.5, 6.5, 8.5])
}

const RUNNING: Sport[] = ['run', 'treadmill']

/** Stats for a single occurrence of a step. */
export function stepStats(step: Step, sport: Sport, profile: Profile, workoutRpe?: number): StepStats {
  const t = step.targets
  const speed = mid(t.speed)
  const grade = (mid(t.incline) ?? 0) / 100

  let duration = step.duration
  let distance = step.distance
  if (duration === undefined && distance !== undefined && speed) duration = distance / (speed / 3.6)
  if (distance === undefined && duration !== undefined && speed) distance = (speed / 3.6) * duration

  let vertical = 0
  let flatDistance: number | undefined
  if (sport === 'stair') {
    const stepRate = mid(t.stepRate)
    if (step.floors !== undefined) vertical = step.floors * profile.stairFloorHeight
    else if (stepRate && duration) vertical = ((stepRate * duration) / 60) * profile.stairStepHeight
    distance = undefined
  } else if (distance !== undefined) {
    vertical = verticalGain(distance, grade)
    flatDistance = RUNNING.includes(sport) ? distance * flatEquivalentRatio(grade) : distance
  }

  const gapSpeed = speed && RUNNING.includes(sport) ? gradeAdjustedSpeed(speed, grade) : undefined
  return { duration, distance, vertical, flatDistance, gapSpeed, zone: stepZone(step, sport, profile, workoutRpe) }
}

/** Intensity zone 1-5, from the most specific information available. */
export function stepZone(step: Step, sport: Sport, profile: Profile, workoutRpe?: number): number {
  const t = step.targets
  if (t.zone) return Math.round(mid(t.zone)!)
  if (t.rpe !== undefined) return rpeZone(t.rpe)
  if (t.power && profile.ftp) return band(mid(t.power)! / profile.ftp, [0.55, 0.75, 0.9, 1.05])
  if (t.hr && profile.lthr) return band(mid(t.hr)! / profile.lthr, [0.85, 0.9, 0.95, 1])
  if (t.speed && profile.thresholdSpeed && RUNNING.includes(sport)) {
    const grade = (mid(t.incline) ?? 0) / 100
    const flatSpeed = mid(t.speed)! * flatEquivalentRatio(grade)
    return band(flatSpeed / profile.thresholdSpeed, [0.78, 0.88, 0.95, 1.02])
  }
  switch (step.kind) {
    case 'wu':
    case 'cd':
    case 'rest':
    case 'pause':
      return 1
    case 'steady':
      return 2
    case 'work':
      return workoutRpe !== undefined ? rpeZone(workoutRpe) : 4
  }
}

/** Zone weights for load when no session RPE is given, on the same scale as RPE. */
const ZONE_LOAD_WEIGHT = [2, 3, 5, 7, 9]

/**
 * Totals for a workout, using the thresholds snapshotted on it. `fallback` (usually
 * the current settings) only applies to workouts logged before snapshots existed.
 */
export function workoutTotals(
  w: Pick<Workout, 'sport' | 'blocks' | 'rpe' | 'duration' | 'profile'>,
  fallback: Profile,
): Totals {
  const profile = w.profile ?? fallback
  const totals: Totals = {
    duration: 0,
    distance: 0,
    vertical: 0,
    flatDistance: 0,
    gapDistance: 0,
    gapTime: 0,
    zoneTime: [0, 0, 0, 0, 0],
    load: 0,
    unknownDuration: 0,
  }
  const unknown = new Set<Step>()
  const cache = new Map<Step, StepStats>()
  for (const step of expand(w.blocks)) {
    // Pauses place the plan against a recording; they aren't training time.
    if (step.kind === 'pause') continue
    let s = cache.get(step)
    if (!s) cache.set(step, (s = stepStats(step, w.sport, profile, w.rpe)))
    if (s.duration === undefined) unknown.add(step)
    else {
      totals.duration += s.duration
      totals.zoneTime[s.zone - 1] += s.duration
    }
    totals.distance += s.distance ?? 0
    totals.vertical += s.vertical
    totals.flatDistance += s.flatDistance ?? s.distance ?? 0
    if (s.duration !== undefined && s.distance !== undefined && RUNNING.includes(w.sport)) {
      totals.gapDistance += s.flatDistance ?? s.distance
      totals.gapTime += s.duration
    }
  }
  totals.unknownDuration = unknown.size

  // An explicit total covers time the structure doesn't describe.
  if (w.duration !== undefined && w.duration > totals.duration) {
    const extra = w.duration - totals.duration
    totals.duration = w.duration
    totals.zoneTime[(w.rpe !== undefined ? rpeZone(w.rpe) : 2) - 1] += extra
  }

  totals.load =
    w.rpe !== undefined
      ? (w.rpe * totals.duration) / 60
      : totals.zoneTime.reduce((sum, secs, i) => sum + (secs / 60) * ZONE_LOAD_WEIGHT[i], 0)
  return totals
}

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    duration: a.duration + b.duration,
    distance: a.distance + b.distance,
    vertical: a.vertical + b.vertical,
    flatDistance: a.flatDistance + b.flatDistance,
    gapDistance: a.gapDistance + b.gapDistance,
    gapTime: a.gapTime + b.gapTime,
    zoneTime: a.zoneTime.map((z, i) => z + b.zoneTime[i]),
    load: a.load + b.load,
    unknownDuration: a.unknownDuration + b.unknownDuration,
  }
}

export function emptyTotals(): Totals {
  return {
    duration: 0,
    distance: 0,
    vertical: 0,
    flatDistance: 0,
    gapDistance: 0,
    gapTime: 0,
    zoneTime: [0, 0, 0, 0, 0],
    load: 0,
    unknownDuration: 0,
  }
}

/** True when pace zones would apply but no threshold pace is recorded. */
export function needsThresholdPace(w: Pick<Workout, 'sport' | 'blocks' | 'profile'>, fallback: Profile): boolean {
  const profile = w.profile ?? fallback
  return (
    !profile.thresholdSpeed &&
    RUNNING.includes(w.sport) &&
    expand(w.blocks, 1000).some((s) => s.targets.speed && !s.targets.zone && s.targets.rpe === undefined)
  )
}
