import { describe, expect, it } from 'vitest'
import type { Profile, RecordingStreams, Step } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { bucketSeries, hrInWindow, hrSeries, sampleAt, stepHr, stepWindows } from './align'

const profile: Profile = { stairStepHeight: 0.2, stairFloorHeight: 3 }
const blocks = (text: string) => parseWorkout(text).blocks
const windows = (text: string, offset = 0) => stepWindows(blocks(text), 'run', profile, undefined, offset)

/** One sample per second at `hrAt(t)`, for times in `ts`. */
const streams = (ts: number[], hrAt: (t: number) => number): RecordingStreams => ({
  recordingId: 'r',
  t: Uint32Array.from(ts),
  hr: Uint8Array.from(ts.map(hrAt)),
})
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

describe('stepWindows', () => {
  it('places steps after the offset', () => {
    expect(windows('5m, 2m', 30).map((w) => [w.start, w.end])).toEqual([
      [30, 330],
      [330, 450],
    ])
  })

  it('respects skipLastRest', () => {
    expect(windows('3x60/30 -r').map((w) => w.end)).toEqual([60, 90, 150, 180, 240])
  })

  it('stops at a step without a duration', () => {
    expect(windows('5m, 1km, 5m')).toHaveLength(1)
  })
})

describe('hrInWindow', () => {
  it('searches by time across a pause', () => {
    // Paused from 100 s to 200 s: no samples there.
    const s = streams([...range(0, 100), ...range(200, 300)], (t) => (t < 100 ? 120 : 160))
    expect(hrInWindow(s, 150, 250)).toEqual({ sum: 160 * 50, n: 50 })
    expect(hrInWindow(s, 100, 200).n).toBe(0)
  })

  it('handles missing HR', () => {
    expect(hrInWindow({ recordingId: 'r', t: Uint32Array.from([0, 1]) }, 0, 2)).toEqual({ sum: 0, n: 0 })
  })
})

describe('stepHr', () => {
  it('averages a repeated step over all its occurrences', () => {
    const b = blocks('2x60/60')
    const [work, rest] = (b[0] as { children: Step[] }).children
    // Work reps at 150 then 170; rest at 110.
    const s = streams(range(0, 240), (t) => (t < 60 ? 150 : t >= 120 && t < 180 ? 170 : 110))
    const hr = stepHr(stepWindows(b, 'run', profile, undefined, 0), s)
    expect(hr.get(work)).toBe(160)
    expect(hr.get(rest)).toBe(110)
  })

  it('shifts with the offset and leaves out steps past the recording', () => {
    const b = blocks('60s, 60s, 60s')
    const s = streams(range(0, 150), (t) => (t < 90 ? 100 : 140))
    const hr = stepHr(stepWindows(b, 'run', profile, undefined, 30), s)
    expect([...hr.values()]).toEqual([100, 140])
  })
})

describe('hrSeries', () => {
  it('buckets samples on the plan clock and breaks at pauses', () => {
    const s = streams([...range(0, 100), ...range(200, 300)], () => 130)
    const series = hrSeries(s, 0, 0, 300, 3)
    expect(series).toEqual([130, undefined, 130])
  })

  it('drops samples before the offset', () => {
    const s = streams(range(0, 100), (t) => (t < 50 ? 90 : 150))
    expect(hrSeries(s, 50, 0, 50, 1)).toEqual([150])
  })

  it("breaks at the plan's pause steps", () => {
    const s = streams(range(0, 300), () => 130)
    expect(hrSeries(s, 0, 0, 300, 3, [[100, 200]])).toEqual([130, undefined, 130])
  })

  it('covers only the requested range', () => {
    const s = streams(range(0, 300), (t) => (t < 100 ? 100 : t < 200 ? 150 : 180))
    expect(hrSeries(s, 0, 100, 200, 2)).toEqual([150, 150])
  })
})

describe('sampleAt', () => {
  const s = { ...streams([...range(0, 100), ...range(200, 300)], (t) => 100 + t / 10), speed: new Float32Array(200).fill(3) }

  it('reads the nearest sample, shifted by the offset', () => {
    expect(sampleAt(s, 60, 10)).toMatchObject({ hr: 107, speed: expect.closeTo(10.8) })
  })

  it('returns nothing during a pause', () => {
    expect(sampleAt(s, 0, 150)).toBeUndefined()
    expect(sampleAt(s, 0, 102)?.hr).toBe(109)
  })
})


describe('bucketSeries', () => {
  it('skips NaN readings', () => {
    const t = Uint32Array.from(range(0, 4))
    expect(bucketSeries(t, Float32Array.of(10, NaN, 20, NaN), 0, 0, 4, 2)).toEqual([10, 20])
  })
})
