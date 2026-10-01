import { flatEquivalentRatio, stepStats } from '../metrics/workout'
import type { Block, Profile, RecordingStreams, Sport, Step } from '../model/types'
import { mid } from '../parser/format'
import { PAUSE, STOP_SPEED, stepWindows, type StepWindow } from './align'

/** Distance, in metres, that outdoor grade is measured over, centred on each sample. */
const GRADE_WINDOW = 30
/** GAP within this fraction of actual pace over the whole activity counts as flat. */
const FLAT_WITHIN = 0.05

export type EffortKind = 'gap' | 'pace' | 'power'

/**
 * Grade (rise over run, as a fraction) at each sample. Outdoors it comes from
 * altitude over about 30 m of distance, which smooths out altitude noise. On a
 * treadmill the recording has no incline, so it is the planned step's incline
 * (`windows`, on the recording's clock).
 */
export function gradeStream(streams: RecordingStreams, sport: Sport, windows: StepWindow[] = []): Float32Array {
  const { t, altitude, distance } = streams
  const out = new Float32Array(t.length)
  if (sport === 'treadmill') {
    let w = 0
    for (let i = 0; i < t.length; i++) {
      while (w < windows.length && windows[w].end <= t[i]) w++
      const step = windows[w]
      if (step && step.start <= t[i]) out[i] = (mid(step.step.targets.incline) ?? 0) / 100
    }
    return out
  }
  if (!altitude || !distance) return out
  let k = 0
  let j = 0
  for (let i = 0; i < t.length; i++) {
    while (distance[k] < distance[i] - GRADE_WINDOW / 2) k++
    while (j + 1 < t.length && distance[j + 1] <= distance[i] + GRADE_WINDOW / 2) j++
    const run = distance[j] - distance[k]
    if (run >= GRADE_WINDOW / 3) out[i] = (altitude[j] - altitude[k]) / run
  }
  return out
}

/** Speed at each sample in km/h, NaN while stopped. */
export function speedStream(streams: RecordingStreams): Float32Array {
  const { speed } = streams
  if (!speed) return new Float32Array(streams.t.length).fill(NaN)
  return Float32Array.from(speed, (v) => (v < STOP_SPEED ? NaN : v * 3.6))
}

/** Grade-adjusted speed (Minetti 2002) at each sample in km/h, NaN while stopped. */
export function gapStream(streams: RecordingStreams, grade: Float32Array): Float32Array {
  return speedStream(streams).map((v, i) => v * flatEquivalentRatio(grade[i]))
}

/**
 * Overall GAP ÷ overall pace: each moving second's flat-equivalent distance over
 * its actual distance. 1 on the flat, above 1 for a hilly or inclined session.
 */
export function gapRatio(streams: RecordingStreams, grade: Float32Array): number {
  const { t, speed } = streams
  if (!speed) return 1
  let actual = 0
  let flat = 0
  for (let i = 1; i < t.length; i++) {
    const dt = t[i] - t[i - 1]
    if (dt > PAUSE || speed[i] < STOP_SPEED) continue
    const d = speed[i] * dt
    actual += d
    flat += d * flatEquivalentRatio(grade[i])
  }
  return actual ? flat / actual : 1
}

/**
 * Which effort metric to chart. Rides show power if recorded. Runs show GAP,
 * unless it's within 5% of actual pace overall, when plain pace says the same.
 */
export function effortKind(sport: Sport, streams: RecordingStreams, ratio: number): EffortKind | undefined {
  if (sport === 'ride') return streams.power ? 'power' : undefined
  if ((sport === 'run' || sport === 'treadmill') && streams.speed) {
    return Math.abs(ratio - 1) >= FLAT_WITHIN ? 'gap' : 'pace'
  }
  return undefined
}

/** A recorded effort metric to chart alongside HR. */
export interface Effort {
  kind: EffortKind
  /** Per sample, aligned with the recording's `t`: km/h for GAP and pace, W for power. 0 or NaN = no reading. */
  values: Float32Array | Uint16Array
  /** The plan's target for a step, in the same unit. */
  planned: (step: Step) => number | undefined
}

/**
 * GAP, pace or power for a workout's linked recording, whichever suits the
 * sport and terrain (see `effortKind`), or undefined if there's nothing to show.
 * `offset` is where step 1 starts in the recording.
 */
export function effortFor(
  streams: RecordingStreams,
  sport: Sport,
  blocks: Block[],
  profile: Profile,
  rpe: number | undefined,
  offset: number,
): Effort | undefined {
  const grade = gradeStream(streams, sport, sport === 'treadmill' ? stepWindows(blocks, sport, profile, rpe, offset) : [])
  const kind = effortKind(sport, streams, gapRatio(streams, grade))
  if (kind === 'gap') {
    return { kind, values: gapStream(streams, grade), planned: (s) => stepStats(s, sport, profile, rpe).gapSpeed }
  }
  if (kind === 'pace') return { kind, values: speedStream(streams), planned: (s) => mid(s.targets.speed) }
  if (kind === 'power' && streams.power) return { kind, values: streams.power, planned: (s) => mid(s.targets.power) }
  return undefined
}

/**
 * Top of a zero-based effort axis: a little above the 98th percentile of the
 * readings (so GPS spikes don't flatten the line) or the highest planned target.
 */
export function effortMax(readings: (number | undefined)[], planned: number[] = []): number {
  const sorted = readings.filter((v) => v !== undefined).sort((a, b) => a - b)
  const top = Math.max(sorted.length ? sorted[Math.floor(0.98 * (sorted.length - 1))] : 0, ...planned)
  return top > 0 ? top * 1.08 : 1
}
