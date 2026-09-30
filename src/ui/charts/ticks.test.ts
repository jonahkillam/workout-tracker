import { describe, expect, it } from 'vitest'
import { paceTicks, timeTicks, valueTicks } from './ticks'

describe('timeTicks', () => {
  it('picks round steps for a whole session', () => {
    expect(timeTicks(0, 2700)).toEqual([0, 600, 1200, 1800, 2400])
  })

  it('picks finer steps when zoomed in', () => {
    expect(timeTicks(605, 690)).toEqual([615, 630, 645, 660, 675, 690])
  })

  it('handles very long ranges', () => {
    expect(timeTicks(0, 36000)).toEqual([0, 7200, 14400, 21600, 28800, 36000])
  })
})

describe('valueTicks', () => {
  it('picks round HR values', () => {
    expect(valueTicks(118, 176)).toEqual([120, 140, 160])
  })

  it('handles a flat range', () => {
    expect(valueTicks(140, 140)).toEqual([140])
  })
})

describe('paceTicks', () => {
  it('labels round paces on a zero-based speed axis, spaced apart', () => {
    // 0–16 km/h over 160 px: 4:00 (15 km/h) is 10 px down, 5:00 (12) 40 px, 6:00 (10) 60 px...
    expect(paceTicks(16, 160)).toEqual([240, 300, 360, 480, 720, 1200])
  })

  it('skips paces faster than the axis', () => {
    expect(paceTicks(11, 100)[0]).toBe(360)
  })
})
