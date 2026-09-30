// Sums up what a recording's streams show: moving time, distance and time at each intensity.
import { db, loadSettings } from '../db/db'
import { profileOf, type Histogram, type Recording, type RecordedSummary, type RecordingStreams } from '../model/types'
import { stoppedAt } from './align'
import { gapStream, gradeStream } from './derived'

/** Histogram bin widths: km/h of GAP, watts, bpm. */
export const GAP_BIN = 0.1
export const POWER_BIN = 5
export const HR_BIN = 1
/** Power is averaged over this many seconds before binning, so single pedal strokes don't set the zone. */
const POWER_WINDOW = 30

function add(h: Histogram, value: number, secs: number) {
  if (!(value >= 0) || !Number.isFinite(value)) return
  const i = Math.floor(value / h.bin)
  while (h.secs.length <= i) h.secs.push(0)
  h.secs[i] += secs
}

/** Trailing POWER_WINDOW-second mean power at each sample. */
function rollingPower(t: Uint32Array, power: Uint16Array): Float64Array {
  const out = new Float64Array(t.length)
  let lo = 0
  let sum = 0
  for (let i = 0; i < t.length; i++) {
    sum += power[i]
    while (t[lo] <= t[i] - POWER_WINDOW) sum -= power[lo++]
    out[i] = sum / (i - lo + 1)
  }
  return out
}

/** The recording's totals and intensity histograms, from its streams. */
export function recordedSummary(rec: Recording, streams: RecordingStreams): RecordedSummary {
  const { t } = streams
  const gap = rec.sport === 'run' && streams.speed ? gapStream(streams, gradeStream(streams, 'run')) : undefined
  const power = rec.sport === 'ride' && streams.power ? rollingPower(t, streams.power) : undefined
  const hists = {
    gap: gap && { bin: GAP_BIN, secs: [] as number[] },
    power: power && { bin: POWER_BIN, secs: [] as number[] },
    hr: streams.hr && { bin: HR_BIN, secs: [] as number[] },
  }
  let moving = 0
  let distance = 0
  for (let i = 1; i < t.length; i++) {
    if (stoppedAt(streams, rec.sport, i)) continue
    const dt = t[i] - t[i - 1]
    moving += dt
    if (streams.distance) distance += Math.max(0, streams.distance[i] - streams.distance[i - 1])
    else if (streams.speed) distance += streams.speed[i - 1] * dt
    // Each interval takes the reading at its start, as distance from speed does.
    if (hists.gap) add(hists.gap, gap![i - 1], dt)
    if (hists.power) add(hists.power, power![i - 1], dt)
    if (hists.hr && streams.hr![i - 1]) add(hists.hr, streams.hr![i - 1], dt)
  }
  const out: RecordedSummary = { moving, distance }
  for (const k of ['gap', 'power', 'hr'] as const) if (hists[k]?.secs.length) out[k] = hists[k]
  return out
}

/**
 * Works out the summary for recordings whose details have arrived but that
 * don't have one yet, snapshotting the current thresholds with it.
 */
export async function fillRecordedSummaries(recordings: Recording[]): Promise<number> {
  const todo = recordings.filter((r) => r.streamsFrom && !r.recorded)
  if (!todo.length) return 0
  const profile = profileOf(await loadSettings())
  for (const r of todo) {
    const streams = await db.recordingStreams.get(r.id)
    // Manual activities have no streams; their summary is what the source reported.
    const recorded = streams?.t.length ? recordedSummary(r, streams) : { moving: r.moving ?? r.elapsed, distance: r.distance ?? 0 }
    await db.recordings.update(r.id, { recorded, profile: r.profile ?? profile })
  }
  return todo.length
}
