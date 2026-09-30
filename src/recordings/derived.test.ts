import { describe, expect, it } from 'vitest'
import { flatEquivalentRatio } from '../metrics/workout'
import type { Profile, RecordingStreams, Step } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { stepWindows } from './align'
import { effortFor, effortKind, effortMax, gapRatio, gapStream, gradeStream, speedStream } from './derived'

const profile: Profile = { stairStepHeight: 0.2, stairFloorHeight: 3 }

/** `n` seconds at a steady `mps`, with altitude from `altAt(distance)`. */
const run = (n: number, mps: number, altAt: (d: number) => number = () => 50): RecordingStreams => {
  const t = Uint32Array.from({ length: n }, (_, i) => i)
  const distance = Float32Array.from(t, (i) => i * mps)
  return {
    recordingId: 'r',
    t,
    speed: new Float32Array(n).fill(mps),
    distance,
    altitude: Float32Array.from(distance, altAt),
  }
}

describe('gradeStream', () => {
  it('measures grade from altitude over distance', () => {
    const g = gradeStream(run(200, 3, (d) => d * 0.06), 'run')
    expect(g[100]).toBeCloseTo(0.06)
  })

  it('smooths altitude noise', () => {
    // ±0.5 m jitter every sample would read as ±33% grade over 3 m.
    const g = gradeStream(run(200, 3, (d) => 50 + (Math.round(d / 3) % 2 ? 0.5 : -0.5)), 'run')
    expect(Math.abs(g[100])).toBeLessThan(0.05)
  })

  it("takes a treadmill's grade from the planned incline", () => {
    const b = parseWorkout('60s @ 10km/h 2%, 60s @ 10km/h 8%').blocks
    const g = gradeStream(run(150, 2.8), 'treadmill', stepWindows(b, 'treadmill', profile, undefined, 10))
    expect([g[5], g[30], g[100], g[140]]).toEqual([0, expect.closeTo(0.02), expect.closeTo(0.08), 0])
  })
})

describe('gapStream', () => {
  it('adjusts speed by the Minetti ratio and blanks stops', () => {
    const s = run(3, 3)
    s.speed![2] = 0
    const gap = gapStream(s, Float32Array.of(0.1, 0.1, 0.1))
    expect(gap[0]).toBeCloseTo(10.8 * flatEquivalentRatio(0.1))
    expect(gap[2]).toBeNaN()
    expect(speedStream(s)[2]).toBeNaN()
  })
})

describe('effortKind', () => {
  it('shows pace for a flat run', () => {
    const s = run(600, 3)
    expect(gapRatio(s, gradeStream(s, 'run'))).toBeCloseTo(1)
    expect(effortKind('run', s, gapRatio(s, gradeStream(s, 'run')))).toBe('pace')
  })

  it('shows GAP for a hilly run', () => {
    const s = run(600, 3, (d) => d * 0.05)
    const ratio = gapRatio(s, gradeStream(s, 'run'))
    expect(ratio).toBeGreaterThan(1.05)
    expect(effortKind('run', s, ratio)).toBe('gap')
  })

  it('switches at 5%', () => {
    const s = run(10, 3)
    expect(effortKind('run', s, 1.049)).toBe('pace')
    expect(effortKind('treadmill', s, 1.05)).toBe('gap')
    expect(effortKind('run', s, 0.94)).toBe('gap')
  })

  it('shows power for rides that record it, and nothing for stairs', () => {
    const s = run(10, 8)
    expect(effortKind('ride', s, 1)).toBeUndefined()
    expect(effortKind('ride', { ...s, power: new Uint16Array(10).fill(200) }, 1)).toBe('power')
    expect(effortKind('stair', s, 1)).toBeUndefined()
  })
})

describe('effortFor', () => {
  it('builds GAP with the plan\'s GAP as the target for a hilly run', () => {
    const b = parseWorkout('10m @ 12km/h').blocks
    const e = effortFor(run(600, 3, (d) => d * 0.05), 'run', b, profile, undefined, 0)!
    expect(e.kind).toBe('gap')
    expect(e.values[300]).toBeCloseTo(10.8 * flatEquivalentRatio(0.05), 1)
    expect(e.planned(b[0] as Step)).toBeCloseTo(12)
  })

  it('builds power for a ride', () => {
    const s = { ...run(10, 8), power: new Uint16Array(10).fill(200) }
    const b = parseWorkout('10s @ 220w').blocks
    const e = effortFor(s, 'ride', b, profile, undefined, 0)!
    expect([e.kind, e.values[0], e.planned(b[0] as Step)]).toEqual(['power', 200, 220])
  })
})

describe('effortMax', () => {
  it('ignores the top 2% of readings', () => {
    const readings = [...Array(99).fill(10), 100]
    expect(effortMax(readings)).toBeCloseTo(10.8)
  })

  it('makes room for the plan', () => {
    expect(effortMax([10, undefined, 10], [20])).toBeCloseTo(21.6)
  })
})
