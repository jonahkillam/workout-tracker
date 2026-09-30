import { stepStats } from '../metrics/workout'
import { expand } from '../model/tree'
import type { Block, Profile, RecordingLink, RecordingStreams, Sport, Step } from '../model/types'

/** Seconds into the recording where step 1 starts. */
export function linkOffset(link: RecordingLink | undefined): number {
  return link?.alignment.method === 'offset' ? link.alignment.offset : 0
}

/** Where one step occurrence falls in the recording, in seconds from the recording start. */
export interface StepWindow {
  step: Step
  start: number
  end: number
}

/** Gaps in the time stream longer than this are pauses (timer stopped or auto-paused). */
export const PAUSE = 10
/** Below this speed an outdoor run or ride is stopped, m/s. */
export const STOP_SPEED = 0.3

/**
 * Whether the recording was stopped between samples `i - 1` and `i`: a gap in
 * the time stream, or, outdoors, standing still with the timer running.
 */
export function stoppedAt(streams: RecordingStreams, sport: Sport, i: number): boolean {
  if (streams.t[i] - streams.t[i - 1] > PAUSE) return true
  return (sport === 'run' || sport === 'ride') && !!streams.speed && streams.speed[i - 1] < STOP_SPEED
}

/** A stretch of plan time, in seconds from step 1. */
export type Span = [start: number, end: number]

/**
 * Places each step occurrence on the recording's clock, with step 1 starting
 * `offset` seconds in. Stops at the first step without a duration, since
 * nothing after it can be placed.
 */
export function stepWindows(blocks: Block[], sport: Sport, profile: Profile, rpe: number | undefined, offset: number): StepWindow[] {
  const out: StepWindow[] = []
  let at = offset
  for (const step of expand(blocks)) {
    const duration = stepStats(step, sport, profile, rpe).duration
    if (!duration) break
    out.push({ step, start: at, end: at + duration })
    at += duration
  }
  return out
}

/** Where the plan's pause steps fall on the plan's clock. */
export function pauseSpans(blocks: Block[], sport: Sport, profile: Profile, rpe?: number): Span[] {
  return stepWindows(blocks, sport, profile, rpe, 0)
    .filter((w) => w.step.kind === 'pause')
    .map((w): Span => [w.start, w.end])
}

/** First index with `t[i] >= x`. */
function lowerBound(t: Uint32Array, x: number): number {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (t[m] < x) lo = m + 1
    else hi = m
  }
  return lo
}

/** Per-sample values to average: HR, GAP, power and so on. Zero or NaN means no reading. */
export type Values = ArrayLike<number>

/** Sum and count of readings with `start <= t < end`. */
function sumInWindow(t: Uint32Array, values: Values, start: number, end: number): { sum: number; n: number } {
  let sum = 0
  let n = 0
  for (let i = lowerBound(t, start); i < t.length && t[i] < end; i++) {
    if (values[i]) {
      sum += values[i]
      n++
    }
  }
  return { sum, n }
}

/** Sum and count of HR samples with `start <= t < end`. Zero readings (dropouts) are skipped. */
export function hrInWindow(streams: RecordingStreams, start: number, end: number): { sum: number; n: number } {
  return streams.hr ? sumInWindow(streams.t, streams.hr, start, end) : { sum: 0, n: 0 }
}

/** Recorded average of `values` per step, over all of its occurrences. Steps with no readings are left out. */
export function stepAverage(windows: StepWindow[], t: Uint32Array, values: Values): Map<Step, number> {
  const acc = new Map<Step, { sum: number; n: number }>()
  for (const w of windows) {
    const { sum, n } = sumInWindow(t, values, w.start, w.end)
    const a = acc.get(w.step) ?? { sum: 0, n: 0 }
    acc.set(w.step, { sum: a.sum + sum, n: a.n + n })
  }
  const out = new Map<Step, number>()
  for (const [step, a] of acc) if (a.n) out.set(step, a.sum / a.n)
  return out
}

/** Recorded average HR per step, over all of its occurrences. Steps with no samples are left out. */
export function stepHr(windows: StepWindow[], streams: RecordingStreams): Map<Step, number> {
  return streams.hr ? stepAverage(windows, streams.t, streams.hr) : new Map()
}

/**
 * `values` averaged into `buckets` equal slices of `[from, to)` on the plan's
 * clock (recording time minus `offset`). Slices with no readings, such as pauses
 * in the recording or the plan's pause steps (`gaps`), are undefined so the line
 * breaks there.
 */
export function bucketSeries(
  t: Uint32Array,
  values: Values,
  offset: number,
  from: number,
  to: number,
  buckets = 500,
  gaps: Span[] = [],
): (number | undefined)[] {
  const sums = new Float64Array(buckets)
  const counts = new Uint32Array(buckets)
  if (to > from) {
    for (let i = lowerBound(t, offset + from); i < t.length; i++) {
      const p = t[i] - offset
      const b = Math.floor(((p - from) / (to - from)) * buckets)
      if (b >= buckets) break
      if (!values[i] || gaps.some(([a, z]) => p >= a && p < z)) continue
      sums[b] += values[i]
      counts[b]++
    }
  }
  return Array.from(sums, (s, b) => (counts[b] ? s / counts[b] : undefined))
}

/** HR in `buckets` slices of `[from, to)` on the plan's clock; see `bucketSeries`. */
export function hrSeries(
  streams: RecordingStreams,
  offset: number,
  from: number,
  to: number,
  buckets = 500,
  gaps: Span[] = [],
): (number | undefined)[] {
  return streams.hr ? bucketSeries(streams.t, streams.hr, offset, from, to, buckets, gaps) : Array(buckets).fill(undefined)
}

/** Recorded values at one moment, from the sample nearest in time. */
export interface Sample {
  hr?: number
  /** km/h. */
  speed?: number
  cadence?: number
  power?: number
  altitude?: number
}

/**
 * The sample nearest `at` on the plan's clock, or undefined if none is within
 * `tolerance` seconds (such as during a pause).
 */
export function sampleAt(streams: RecordingStreams, offset: number, at: number, tolerance = 5): Sample | undefined {
  const { t } = streams
  const target = at + offset
  const i = lowerBound(t, target)
  const j = i > 0 && (i === t.length || target - t[i - 1] < t[i] - target) ? i - 1 : i
  if (j >= t.length || Math.abs(t[j] - target) > tolerance) return undefined
  return {
    hr: streams.hr?.[j] || undefined,
    speed: streams.speed ? streams.speed[j] * 3.6 : undefined,
    cadence: streams.cadence?.[j],
    power: streams.power?.[j],
    altitude: streams.altitude?.[j],
  }
}
