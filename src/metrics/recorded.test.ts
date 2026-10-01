import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, profileOf, type Profile, type Recording, type RecordingStreams, type Sport, type Workout } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { recordedSummary } from '../recordings/recorded'
import { recordedAverage, recordedTotals, sessionTotals } from './recorded'
import { summarizeWeeks } from './week'
import { workoutTotals } from './workout'

const NO_THRESHOLDS: Profile = profileOf(DEFAULT_SETTINGS)

/** A 1 Hz flat recording from [seconds, m/s, W, bpm] pieces, with its summary filled in. */
function recording(sport: Sport, pieces: [number, number, number, number][], extra: Partial<Recording> = {}): Recording {
  const v: number[] = []
  const w: number[] = []
  const hr: number[] = []
  for (const [secs, speed, power, bpm] of pieces) {
    for (let i = 0; i < secs; i++) {
      v.push(speed)
      w.push(power)
      hr.push(bpm)
    }
  }
  const streams: RecordingStreams = {
    recordingId: 'r',
    t: Uint32Array.from({ length: v.length + 1 }, (_, i) => i),
    speed: Float32Array.from([...v, v[v.length - 1]]),
    power: Uint16Array.from([...w, w[w.length - 1]]),
    hr: Uint8Array.from([...hr, hr[hr.length - 1]]),
  }
  const rec: Recording = {
    id: 'r',
    startTime: '2026-09-29T07:00:00Z',
    localDate: '2026-09-29',
    sport,
    rawSport: sport,
    elapsed: v.length,
    laps: [],
    detailsFetched: true,
    updatedAt: 0,
    ...extra,
  }
  return { ...rec, recorded: recordedSummary(rec, streams) }
}

describe('recordedSummary', () => {
  it('counts moving time and distance, and bins GAP, power and HR', () => {
    const r = recording('run', [[600, 3, 0, 140], [120, 0, 0, 100], [600, 4, 0, 160]])
    expect(r.recorded!.moving).toBe(1200)
    expect(r.recorded!.distance).toBeCloseTo(600 * 3 + 600 * 4)
    // 3 m/s = 10.8 km/h, 4 m/s = 14.4 km/h, on the flat.
    const gap = r.recorded!.gap!
    expect(gap.secs[Math.floor(10.8 / gap.bin + 1e-6)]).toBe(600)
    expect(gap.secs.reduce((a, b) => a + b)).toBe(1200)
    expect(r.recorded!.power).toBeUndefined()
    expect(r.recorded!.hr!.secs[140]).toBe(600)
    // Stopped time isn't binned.
    expect(r.recorded!.hr!.secs[100]).toBeFalsy()
  })

  it('bins 30 s rolling power for rides', () => {
    const r = recording('ride', [[600, 8, 200, 140]])
    expect(r.recorded!.power!.secs[200 / 5]).toBe(600)
    expect(r.recorded!.gap).toBeUndefined()
  })
})

describe('recordedTotals', () => {
  const run = recording('run', [[1200, 3, 0, 140], [1200, 4.2, 0, 170]], { distance: 8700, elevationGain: 40 })

  it('takes distance and climb from the recording, and time from moving time', () => {
    const t = recordedTotals(run, 'run', NO_THRESHOLDS)
    expect(t.duration).toBe(2400)
    expect(t.distance).toBe(8700)
    expect(t.vertical).toBe(40)
    expect(t.gapTime).toBe(2400)
  })

  it('zones runs by GAP against threshold pace first', () => {
    // Threshold 15 km/h: 10.8 km/h is 72% (Z1), 15.12 km/h is 101% (Z4).
    const t = recordedTotals(run, 'run', { ...NO_THRESHOLDS, thresholdSpeed: 15, lthr: 150 })
    expect(t.zoneTime).toEqual([1200, 0, 0, 1200, 0])
    expect(t.load).toBeCloseTo(20 * 2 + 20 * 7)
  })

  it('falls back to HR against LTHR', () => {
    // LTHR 170: 140 bpm is 82% (Z1), 170 bpm is 100% (Z5).
    expect(recordedTotals(run, 'run', { ...NO_THRESHOLDS, lthr: 170 }).zoneTime).toEqual([1200, 0, 0, 0, 1200])
  })

  it('falls back to the planned zones stretched to the recorded time, then Z2', () => {
    const planned = workoutTotals({ sport: 'run', blocks: parseWorkout('10m wu, 10m work').blocks }, NO_THRESHOLDS)
    expect(recordedTotals(run, 'run', NO_THRESHOLDS, { planned }).zoneTime).toEqual([1200, 0, 0, 1200, 0])
    expect(recordedTotals(run, 'run', NO_THRESHOLDS).zoneTime).toEqual([0, 2400, 0, 0, 0])
  })

  it('uses session RPE for load', () => {
    expect(recordedTotals(run, 'run', NO_THRESHOLDS, { rpe: 6 }).load).toBe(6 * 40)
  })

  it('zones rides by power against FTP', () => {
    const ride = recording('ride', [[1200, 8, 150, 130], [1200, 9, 250, 160]])
    // FTP 250: 150 W is 60% (Z2), 250 W is 100% (Z4). The 30 s average passes through Z3 on the way up.
    const z = recordedTotals(ride, 'ride', { ...NO_THRESHOLDS, ftp: 250 }).zoneTime
    expect(z[0] + z[4]).toBe(0)
    expect(z[2]).toBeLessThan(30)
    expect(Math.abs(z[1] - 1200)).toBeLessThan(30)
    expect(Math.abs(z[3] - 1200)).toBeLessThan(30)
  })
})

describe('sessionTotals and summarizeWeek', () => {
  const workout = (sport: Sport, text: string, recordingId?: string): Workout => ({
    id: `${sport}-${text}`,
    date: '2026-09-29',
    sport,
    rawText: text,
    blocks: parseWorkout(text, { speedUnit: 'pace' }).blocks,
    recording: recordingId ? { id: recordingId, linkedBy: 'auto', offset: 0 } : undefined,
    createdAt: 0,
    updatedAt: 0,
  })
  const run = { ...recording('run', [[2400, 3, 0, 140]], { distance: 7300 }), id: 'run' }

  it('uses the recording for a linked run, and the plan for a treadmill', () => {
    expect(sessionTotals(workout('run', '5x3m/2m @ 4:00/km'), run, NO_THRESHOLDS).distance).toBe(7300)
    const treadmill = { ...recording('treadmill', [[1800, 2.5, 0, 140]], { distance: 9999 }), id: 'tm' }
    expect(sessionTotals(workout('treadmill', '30m @ 6km/h'), treadmill, NO_THRESHOLDS).distance).toBeCloseTo(3000)
  })

  it('counts unlinked recordings as sessions', () => {
    const ride = { ...recording('ride', [[3600, 8, 180, 130]], { distance: 30000 }), id: 'ride' }
    const [s] = summarizeWeeks('2026-09-28', 1, [workout('run', '40m', 'run')], NO_THRESHOLDS, [run, ride])
    expect(s.bySport.run).toMatchObject({ count: 1, distance: 7300 })
    expect(s.bySport.ride).toMatchObject({ count: 1, distance: 30000, duration: 3600 })
    expect(s.total.duration).toBe(2400 + 3600)
    expect(s.dailyLoad[1]).toBeCloseTo(s.total.load)
  })
})

describe('recordedAverage', () => {
  const base = { moving: 1800, distance: 6000 }

  it('gives runs a pace and rides a speed over moving time', () => {
    expect(recordedAverage(recording('run', [[10, 3, 0, 140]], base), 'kmh')).toBe('5:00/km')
    expect(recordedAverage({ ...recording('ride', [[10, 3, 0, 140]], base), recorded: undefined }, 'pace')).toBe('12 km/h')
  })

  it('prefers average power from the histogram', () => {
    const recorded = { moving: 20, power: { bin: 10, secs: [0, 0, 10, 10] } }
    expect(recordedAverage({ ...recording('ride', [[10, 3, 0, 140]], base), recorded } as Recording, 'kmh')).toBe('30 W')
  })

  it('has nothing for stairs or without distance', () => {
    expect(recordedAverage(recording('stair', [[10, 0, 0, 140]], base), 'kmh')).toBeUndefined()
    expect(recordedAverage(recording('run', [[10, 3, 0, 140]], { moving: 1800 }), 'kmh')).toBeUndefined()
  })
})
