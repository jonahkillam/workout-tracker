import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Workout } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { isoWeek } from './dates'
import { acuteChronicRatio, summarizeWeeks } from './week'
import {
  averageGap,
  climbRate,
  flatEquivalentRatio,
  gradeAdjustedSpeed,
  speedForClimbRate,
  speedForGap,
  stairClimbRate,
  stairGap,
  workoutTotals,
} from './workout'

const totals = (sport: Workout['sport'], text: string, extra: Partial<Workout> = {}) =>
  workoutTotals({ sport, blocks: parseWorkout(text).blocks, ...extra }, DEFAULT_SETTINGS)

describe('workoutTotals', () => {
  it('derives distance and vertical gain from treadmill speed and incline', () => {
    const t = totals('treadmill', '30m @ 8.5km/h, 15%')
    expect(t.duration).toBe(1800)
    expect(t.distance).toBeCloseTo(4250)
    // Rise along a 15% slope: 4250 × 0.15 / √(1 + 0.15²) ≈ 630m.
    expect(t.vertical).toBeCloseTo(630.4, 0)
    expect(t.flatDistance).toBeCloseTo(4250 * flatEquivalentRatio(0.15))
  })

  it('totals the example interval session', () => {
    const t = totals('treadmill', '10m wu @ 6km/h, 3x10x40/20 @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd @ 5km/h')
    // 20m + 3 × 10 × 60s = 50 minutes.
    expect(t.duration).toBe(3000)
    const work = (8.55 / 3.6) * 40 * 30
    const rest = (6.75 / 3.6) * 20 * 30
    expect(t.distance).toBeCloseTo(1000 + work + rest + 833.33, 0)
    expect(t.vertical).toBeCloseTo(((work + rest) * 0.15) / Math.sqrt(1.0225), 3)
    expect(t.zoneTime.reduce((a, b) => a + b)).toBe(3000)
  })

  it('computes stair climber gain from step rate or floors', () => {
    expect(totals('stair', '30m @ 70spm').vertical).toBeCloseTo(30 * 70 * DEFAULT_SETTINGS.stairStepHeight)
    expect(totals('stair', '100fl').vertical).toBeCloseTo(325)
    expect(totals('stair', '30m @ 70spm').distance).toBe(0)
  })

  it('uses session RPE for load and fills the explicit total duration', () => {
    const t = totals('run', '', { rpe: 4, duration: 3600 })
    expect(t.duration).toBe(3600)
    expect(t.load).toBe(240)
    expect(t.zoneTime[1]).toBe(3600)
  })

  it('leaves pauses out of time, distance, zones and load', () => {
    const t = totals('run', '20m @ 5:00/km, 25m pause, 20m @ 5:00/km')
    expect(t.duration).toBe(2400)
    expect(t.distance).toBeCloseTo(8000)
    expect(t.zoneTime.reduce((a, b) => a + b)).toBe(2400)
    expect(t.load).toBe(totals('run', '40m @ 5:00/km').load)
  })

  it('counts steps whose duration is unknown', () => {
    expect(totals('run', '5km').unknownDuration).toBe(1)
  })

  it('counts zones outside 1-5 as the nearest zone', () => {
    expect(totals('run', '10m @ Z7').zoneTime).toEqual([0, 0, 0, 0, 600])
    expect(totals('run', '10m @ Z0').zoneTime).toEqual([600, 0, 0, 0, 0])
    expect(totals('run', '10m @ Z7').load).toBe(totals('run', '10m @ Z5').load)
  })
})

describe('grade-adjusted pace', () => {
  it('is the flat speed with the same energy cost', () => {
    expect(gradeAdjustedSpeed(10, 0)).toBe(10)
    expect(gradeAdjustedSpeed(8.5, 0.15)).toBeCloseTo(8.5 * flatEquivalentRatio(0.15))
    expect(speedForGap(gradeAdjustedSpeed(8.5, 0.15), 0.15)).toBeCloseTo(8.5)
  })

  it('averages over timed running steps only', () => {
    const t = totals('treadmill', '10m @ 10km/h, 10m @ 10km/h, 10%, 5km')
    const expected = ((10 + gradeAdjustedSpeed(10, 0.1)) / 2)
    expect(averageGap(t)).toBeCloseTo(expected)
    expect(averageGap(totals('stair', '30m @ 70spm'))).toBeUndefined()
  })
})

describe('climb rate', () => {
  it('converts treadmill speed and incline to vertical metres per hour', () => {
    expect(climbRate(6, 0)).toBe(0)
    expect(climbRate(6, 0.15)).toBeCloseTo((6000 * 0.15) / Math.sqrt(1 + 0.15 ** 2))
    expect(speedForClimbRate(climbRate(6, 0.15), 0.15)).toBeCloseTo(6)
    expect(speedForClimbRate(800, 0)).toBeUndefined()
  })

  it('uses step rate and step height on the stair climber', () => {
    expect(DEFAULT_SETTINGS.stairStepHeight).toBe(3.25 / 16)
    expect(stairClimbRate(80, 0.2)).toBeCloseTo(960)
  })

  it('treats the stair climber as a 45% grade for GAP', () => {
    const along = speedForClimbRate(975, 0.45)!
    expect(climbRate(along, 0.45)).toBeCloseTo(975)
    expect(stairGap(975)).toBeCloseTo(gradeAdjustedSpeed(along, 0.45))
    expect(stairGap(975)).toBeGreaterThan(12)
  })
})

describe('threshold snapshots', () => {
  it("uses the workout's own thresholds, not the current settings", () => {
    const blocks = parseWorkout('30m @ 12km/h').blocks
    const then = { ...DEFAULT_SETTINGS, thresholdSpeed: 12 }
    const now = { ...DEFAULT_SETTINGS, thresholdSpeed: 16 }
    // 12 km/h was threshold (Z4) when logged; against today's 16 km/h it would be Z1.
    expect(workoutTotals({ sport: 'run', blocks, profile: then }, now).zoneTime[3]).toBe(1800)
    expect(workoutTotals({ sport: 'run', blocks }, now).zoneTime[0]).toBe(1800)
  })
})

describe('missing thresholds', () => {
  it('falls back to step type when no threshold pace is recorded', () => {
    const t = totals('run', '10m wu @ 10km/h, 3x5m/2m @ 15km/h//9km/h')
    // wu Z1, work (no RPE) Z4, rest Z1.
    expect(t.zoneTime).toEqual([600 + 3 * 120, 0, 0, 900, 0])
  })

  it('does not count a dropped final rest', () => {
    expect(totals('run', '5x3m/2m -r').duration).toBe(5 * 180 + 4 * 120)
  })
})

describe('weeks', () => {
  it('computes the acute:chronic ratio over five weeks', () => {
    const w = (date: string, rpe: number): Workout => ({
      id: date,
      date,
      sport: 'run',
      rpe,
      duration: 3600,
      rawText: '',
      blocks: [],
      createdAt: 0,
      updatedAt: 0,
    })
    // Mondays: 2026-08-31 .. 2026-09-28
    const workouts = [w('2026-08-31', 5), w('2026-09-07', 5), w('2026-09-14', 5), w('2026-09-21', 5), w('2026-09-29', 10)]
    const weeks = summarizeWeeks('2026-09-28', 5, workouts, DEFAULT_SETTINGS)
    expect(weeks.map((x) => x.total.load)).toEqual([300, 300, 300, 300, 600])
    expect(weeks[4].dailyLoad[1]).toBe(600)
    expect(acuteChronicRatio(weeks)).toBe(2)
  })
})

describe('isoWeek', () => {
  it('matches ISO 8601 week numbering, including year boundaries', () => {
    expect(isoWeek('2026-09-28')).toBe(40)
    expect(isoWeek('2026-01-01')).toBe(1)
    expect(isoWeek('2021-01-03')).toBe(53)
    expect(isoWeek('2020-12-31')).toBe(53)
    expect(isoWeek('2024-12-30')).toBe(1)
  })
})
