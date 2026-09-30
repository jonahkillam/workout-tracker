import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, profileOf, type Lap, type Profile, type Recording, type RecordingStreams, type Sport } from '../model/types'
import { mainSetSummary } from '../parser/summary'
import { parseWorkout } from '../parser/parser'
import { serializeBlocks } from '../parser/serialize'
import { detectText } from './autolog'
import { detectBlocks, isAutoLaps } from './intervals'

const NO_THRESHOLDS: Profile = profileOf(DEFAULT_SETTINGS)

type Piece = [secs: number, value: number | null, grade?: number]

/**
 * A 1 Hz activity from [seconds, value, grade] pieces: m/s for runs, watts for
 * rides. A null value is a timer pause, with no samples.
 */
function activity(sport: Sport, pieces: Piece[], laps?: 'pieces' | Lap[]) {
  const t: number[] = []
  const v: number[] = []
  const g: number[] = []
  const lapList: Lap[] = []
  let now = 0
  for (const [secs, value, grade = 0] of pieces) {
    // The watch records a sample as the timer stops.
    if (value === null && v.length) {
      t.push(now)
      v.push(v[v.length - 1])
      g.push(0)
    }
    if (value !== null) {
      lapList.push({ start: now, duration: secs, distance: secs * value })
      for (let i = 0; i < secs; i++) {
        t.push(now + i)
        v.push(value)
        g.push(grade)
      }
    }
    now += secs
  }
  // A closing sample, so the activity lasts exactly the sum of the pieces.
  t.push(now)
  v.push(v[v.length - 1])
  g.push(0)
  const distance = [0]
  const altitude = [100]
  for (let i = 1; i < t.length; i++) {
    const step = t[i] - t[i - 1] === 1 ? v[i - 1] : 0
    distance.push(distance[i - 1] + step)
    altitude.push(altitude[i - 1] + step * g[i - 1])
  }
  const streams: RecordingStreams = {
    recordingId: 'r',
    t: Uint32Array.from(t),
    ...(sport === 'ride'
      ? { power: Uint16Array.from(v) }
      : { speed: Float32Array.from(v), distance: Float32Array.from(distance), altitude: Float32Array.from(altitude) }),
  }
  const rec: Recording = {
    id: 'r',
    startTime: '2026-09-29T07:00:00Z',
    localDate: '2026-09-29',
    sport,
    rawSport: sport === 'ride' ? 'Ride' : 'Run',
    elapsed: now,
    laps: laps === 'pieces' ? lapList : (laps ?? []),
    importedAt: 0,
    updatedAt: 0,
  }
  return { rec, streams }
}

const text = (a: { rec: Recording; streams: RecordingStreams }, profile = NO_THRESHOLDS) =>
  detectText(a.rec, a.streams, profile)?.rawText

const structured = (a: { rec: Recording; streams: RecordingStreams }, profile = NO_THRESHOLDS) =>
  detectText(a.rec, a.streams, profile)?.structured

const reps = (n: number, work: Piece, rest: Piece): Piece[] =>
  Array.from({ length: n }, (_, i) => (i < n - 1 ? [work, rest] : [work])).flat()

describe('detectBlocks', () => {
  it('logs a steady run as one step at its average pace', () => {
    expect(text(activity('run', [[2400, 3]]))).toBe('40m @ 5:33/km')
  })

  it('treats a run with 1 km auto-laps as steady', () => {
    const laps = Array.from({ length: 8 }, (_, i) => ({ start: i * 333, duration: 333, distance: 1000 }))
    expect(isAutoLaps(laps)).toBe(true)
    expect(text(activity('run', [[2664, 3]], laps))).toBe('44m24s @ 5:33/km')
  })

  it('groups lap-marked 800 m reps into one repeat', () => {
    const a = activity('run', [[600, 3], ...reps(6, [160, 5], [90, 2.5]), [600, 3]], 'pieces')
    expect(isAutoLaps(a.rec.laps)).toBe(false)
    expect(text(a)).toBe('10m wu @ 5:33/km, 6x800mtr/90s -r @ 3:20/km, 10m cd @ 5:33/km')
  })

  it('splits reps whose times differ by more than 10 s', () => {
    const pieces = [[600, 3], ...reps(6, [160, 5], [90, 2.5]), [600, 3]] as Piece[]
    pieces[7] = [172, 800 / 172] // fourth rep, 12 s slower
    expect(text(activity('run', pieces, 'pieces'))).toBe(
      '10m wu @ 5:33/km, 3x800mtr/90s @ 3:20/km, 800mtr work @ 3:35/km, 90s rec, 2x800mtr/90s -r @ 3:20/km, 10m cd @ 5:33/km',
    )
  })

  it('uses a pace range for reps within 10 s of each other', () => {
    const pieces = [[600, 3], ...reps(3, [160, 5], [90, 2.5]), [600, 3]] as Piece[]
    pieces[3] = [165, 800 / 165]
    expect(text(activity('run', pieces, 'pieces'))).toBe('10m wu @ 5:33/km, 3x800mtr/90s -r @ 3:20-3:26/km, 10m cd @ 5:33/km')
  })

  it('finds reps in the stream when there are no laps', () => {
    expect(text(activity('run', [[600, 3], ...reps(5, [180, 4.2], [120, 2.5]), [600, 3]]))).toBe(
      '10m wu @ 5:33/km, 5x3m/2m -r @ 3:58/km, 10m cd @ 5:33/km',
    )
  })

  it('snaps stream boundaries onto nearby auto-laps', () => {
    const pieces = [[608, 3], ...reps(4, [292, 4.2], [308, 2.5]), [600, 3]] as Piece[]
    const total = pieces.reduce((a, [s]) => a + s, 0)
    const laps = Array.from({ length: Math.ceil(total / 300) }, (_, i) => ({ start: i * 300, duration: Math.min(300, total - i * 300) }))
    expect(text(activity('run', pieces, laps))).toMatch(/^10m wu @ 5:33\/km, 4x5m\/5m -r @ 4:\d\d-4:\d\d\/km, 10m cd @ 5:33\/km$/)
  })

  it('uses power zones for rides', () => {
    const a = activity('ride', [[600, 150], ...reps(3, [600, 250], [300, 120]), [600, 150]])
    const out = text(a, { ...NO_THRESHOLDS, ftp: 250 })!
    expect(out).toBe('10m wu @ 150w, 3x10m/5m -r @ 250w, 10m cd @ 150w')
    expect(mainSetSummary(parseWorkout(out).blocks)).toMatch(/^3×/)
  })

  it('logs a ride without FTP from its two power levels', () => {
    const out = text(activity('ride', [[600, 150], ...reps(3, [600, 280], [300, 120]), [600, 150]]))
    expect(out).toMatch(/3x.* -r @ 2\d\dw/)
  })

  it('never uses speed for rides', () => {
    const { rec, streams } = activity('run', [[1200, 8]])
    expect(detectBlocks({ ...rec, sport: 'ride' }, streams, NO_THRESHOLDS)).toBeUndefined()
  })

  it('skips treadmill and stair recordings', () => {
    const { rec, streams } = activity('run', [[1200, 3]])
    expect(detectBlocks({ ...rec, sport: 'treadmill' }, streams, NO_THRESHOLDS)).toBeUndefined()
    expect(detectBlocks({ ...rec, sport: 'stair' }, streams, NO_THRESHOLDS)).toBeUndefined()
  })

  it('leaves an easy run with threshold pace set as steady', () => {
    const profile = { ...NO_THRESHOLDS, thresholdSpeed: 16 }
    expect(text(activity('run', [[600, 3], [600, 3.3], [600, 3]]), profile)).toMatch(/^30m @ 5:\d\d\/km$/)
  })

  it('writes standing still as a pause', () => {
    expect(text(activity('run', [[1200, 3], [1200, 0], [1200, 3]]))).toBe('20m @ 5:33/km, 20m pause, 20m @ 5:33/km')
  })

  it('writes a timer pause as a pause', () => {
    expect(text(activity('run', [[1200, 3], [1200, null], [1200, 3]]))).toBe('20m @ 5:33/km, 20m pause, 20m @ 5:33/km')
  })

  it('leaves short stops inside a step', () => {
    expect(text(activity('run', [[1200, 3], [30, 0], [1200, 3]]))).toBe('40m30s @ 5:33/km')
  })

  it('writes a long stop in a recovery as a pause', () => {
    const a = activity('run', [[600, 3], [160, 5], [90, 2.5], [160, 5], [600, 0], [160, 5], [600, 3]], 'pieces')
    expect(text(a)).toBe('10m wu @ 5:33/km, 2x800mtr/90s -r @ 3:20/km, 10m pause, 800mtr work @ 3:20/km, 10m cd @ 5:33/km')
  })

  it('keeps standing recoveries between reps', () => {
    const a = activity('run', [[600, 3], ...reps(4, [160, 5], [90, 0]), [600, 3]], 'pieces')
    expect(text(a)).toBe('10m wu @ 5:33/km, 4x800mtr/90s -r @ 3:20/km, 10m cd @ 5:33/km')
  })

  it('splits work from rest on grade-adjusted pace, so hills at steady effort stay steady', () => {
    // Slow up a 10% grade and fast down it, at about the same grade-adjusted pace.
    const hills = Array.from({ length: 6 }, (_, i): Piece => (i % 2 ? [300, 5.5, -0.1] : [300, 2, 0.1]))
    // Net 315 m down over 6.75 km.
    expect(text(activity('run', hills))).toBe('30m @ -4.7%, 4:27/km')
  })

  it('keeps a stretch only slightly faster than its neighbours steady', () => {
    // Threshold 16 km/h puts work at 3.91 m/s and up; 4.0 against 3.8 isn't clearly harder.
    const profile = { ...NO_THRESHOLDS, thresholdSpeed: 16 }
    expect(text(activity('run', [[600, 3.8], [1200, 4], [600, 3.8]]), profile)).toMatch(/^40m @ 4:\d\d\/km$/)
  })

  it('keeps a run that is all above threshold pace steady', () => {
    const profile = { ...NO_THRESHOLDS, thresholdSpeed: 16 }
    expect(text(activity('run', [[2400, 4.2]]), profile)).toBe('40m @ 3:58/km')
  })

  it('only marks the first stretch as a warm-up, and only when clearly easier than the next', () => {
    const a = activity('run', [[600, 3], [120, 0], [600, 3], ...reps(4, [180, 4.2], [120, 2.5]), [600, 3]])
    expect(text(a)).toBe('10m @ 5:33/km, 2m pause, 10m @ 5:33/km, 4x3m/2m -r @ 3:58/km, 10m cd @ 5:33/km')
  })

  it('adds the average grade to hill reps and their recoveries', () => {
    const a = activity('run', [[600, 3], ...reps(4, [60, 4, 0.06], [90, 2, -0.12]), [600, 3]])
    const d = detectText(a.rec, a.streams, NO_THRESHOLDS)!
    expect(d.rawText).toBe('10m wu @ 5:33/km, 4x60/90 -r @ 6%//-12%, 4:10/km, 10m cd @ 5:33/km')
    expect(serializeBlocks(d.blocks)).toBe(d.rawText)
  })

  it('leaves grades under 0.5% off', () => {
    expect(text(activity('run', [[2400, 3, 0.004]]))).toBe('40m @ 5:33/km')
  })

  it('writes text that round-trips', () => {
    const a = activity('run', [[600, 3], ...reps(6, [160, 5], [90, 2.5]), [600, 3]], 'pieces')
    const d = detectText(a.rec, a.streams, NO_THRESHOLDS)!
    expect(serializeBlocks(d.blocks)).toBe(d.rawText)
    expect(parseWorkout(d.rawText).blocks).toEqual(d.blocks)
  })

  describe('only structures what clearly looks like a workout', () => {
    it('marks interval sessions structured', () => {
      expect(structured(activity('run', [[600, 3], ...reps(5, [180, 4.2], [120, 2.5]), [600, 3]]))).toBe(true)
      expect(structured(activity('run', [[600, 3], ...reps(6, [160, 5], [90, 2.5]), [600, 3]], 'pieces'))).toBe(true)
      expect(structured(activity('ride', [[600, 150], ...reps(3, [600, 280], [300, 120]), [600, 150]]))).toBe(true)
    })

    it('marks steady runs, runs with stops and hills unstructured', () => {
      expect(structured(activity('run', [[2400, 3]]))).toBe(false)
      expect(structured(activity('run', [[1200, 3], [1200, 0], [1200, 3]]))).toBe(false)
      const hills = Array.from({ length: 6 }, (_, i): Piece => (i % 2 ? [300, 5.5, -0.1] : [300, 2, 0.1]))
      expect(structured(activity('run', hills))).toBe(false)
    })

    it('leaves a single surge unstructured', () => {
      const a = activity('run', [[900, 3], [300, 4.2], [900, 3]])
      expect(structured(a)).toBe(false)
      expect(text(a)).toMatch(/^35m @ \d:\d\d\/km$/)
    })

    it('treats a tempo broken up by irregular stops as one effort', () => {
      const a = activity('run', [[600, 3], [300, 4.2], [25, 0], [420, 4.2], [50, 0], [240, 4.2], [35, 0], [500, 4.2], [600, 3]])
      expect(structured(a)).toBe(false)
      expect(text(a)).not.toMatch(/work|x/)
    })

    it('keeps regular reps with standing recoveries, even with no warm-up', () => {
      const a = activity('run', reps(4, [160, 5], [90, 0]))
      expect(structured(a, { ...NO_THRESHOLDS, thresholdSpeed: 16 })).toBe(true)
      expect(text(a, { ...NO_THRESHOLDS, thresholdSpeed: 16 })).toMatch(/^4x800mtr\/90s -r/)
    })

    it('leaves reps with recoveries barely slower than the reps unstructured', () => {
      expect(structured(activity('run', [[600, 3], ...reps(5, [180, 4.2], [120, 3.85]), [600, 3]]))).toBe(false)
    })
  })
})
