import { describe, expect, it } from 'vitest'
import { parseWorkout } from './parser'
import { mainSetSummary } from './summary'

const summary = (src: string, unit?: 'kmh' | 'pace') => mainSetSummary(parseWorkout(src, { speedUnit: unit }).blocks, unit)

describe('mainSetSummary', () => {
  it('reduces a repeat to its shape and one key target', () => {
    expect(summary('10m wu @ 6km/h, 3x10x40/20 r2m -r @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd')).toBe('3×10×40/20s @ 15%')
    expect(summary('15m wu, 5x1km/90s @ 4:05/km, 10m cd', 'pace')).toBe('5×1km/90s @ 4:05/km')
    expect(summary('6x800mtr w/ 90s @ Z4')).toBe('6×800mtr/90s @ Z4')
    expect(summary('4x8m @ 250-260w')).toBe('4×8m @ 250-260W')
  })

  it('counts every step of a repeat body that is not a work/rest pair', () => {
    expect(summary('4x(1m, 2m, 3m)')).toBe('4×(3 steps)')
    expect(summary('3x(5m @ Z4, 3m @ Z3, 2m @ Z1)')).toBe('3×(3 steps) @ Z4')
    expect(summary('4x(1m work, 1m rec, 2m work, 2m rec)')).toBe('4×(4 steps)')
    expect(summary('4x(3m, 2m work)')).toBe('4×(2 steps)')
    expect(summary('4x(3m work, 1m rec)')).toBe('4×3m/1m')
  })

  it('ignores pauses', () => {
    expect(summary('1h50m @ 9:40/km, 3h pause, 2h40m @ 9:20/km', 'pace')).toBe(summary('1h50m @ 9:40/km, 2h40m @ 9:20/km', 'pace'))
  })

  it('shows minutes with seconds as a clock, never a decimal', () => {
    expect(summary('4x2m30s/90s @ Z4')).toBe('4×0:02:30/90s @ Z4')
    expect(summary('7m20s @ Z3')).toBe('0:07:20 @ Z3')
  })

  it('keeps paces typed as paces and rounds km/h', () => {
    expect(summary('5x1km/90s @ 4:05/km, 6x200mtr/200mtr @ 3:30/km')).toBe('5×1km/90s @ 4:05/km + 6×200mtr/200mtr @ 3:30/km')
    expect(summary('20m @ 10.25-10.75km/h')).toBe('20m @ 10.3-10.8km/h')
  })

  it('treats an easy step after a nested repeat as the set recovery', () => {
    expect(summary('3x(10x(40s @ 8.5km/h 15%, 20s 6.7km/h 15%), 5m 6km/h easy 15%) -r')).toBe('3×10×40/20s @ 15%')
  })

  it('joins several main sets', () => {
    expect(summary('15m wu, 4x5m/2m @ Z4, 10m, 6x1m/1m @ Z5, 10m cd')).toBe('4×5m/2m @ Z4 + 6×1m/1m @ Z5')
  })

  it('shows the main step when there are no repeats', () => {
    expect(summary('45m @ 10km/h', 'pace')).toBe('45m @ 6:00/km')
    expect(summary('5m @ lvl5, 20m @ lvl9, 80spm, 5m @ lvl5')).toBe('20m @ L9')
    expect(summary('1h15m easy @ Z2')).toBe('1h15 @ Z2')
    expect(summary('1h59m45s @ Z2')).toBe('2h @ Z2')
    expect(summary('')).toBe('')
  })

  it('picks the longest step by time, estimating it from distance and speed', () => {
    // 2km at 6km/h is 20 minutes.
    expect(summary('2km @ 6km/h, 15m @ 12km/h')).toBe('2km @ 6km/h')
    expect(summary('5km @ 12km/h, 30m @ 6km/h')).toBe('30m @ 6km/h')
    // Without speeds, by distance.
    expect(summary('400mtr, 2km')).toBe('2km')
  })
})
