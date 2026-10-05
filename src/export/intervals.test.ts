import { describe, expect, it } from 'vitest'
import { expand } from '../model/tree'
import type { Sport } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { intervalsEvent, intervalsText, workoutIdOf } from './intervals'

const text = (shorthand: string, sport: Sport = 'run', lthr?: number) =>
  intervalsText(parseWorkout(shorthand).blocks, sport, { stairStepHeight: 0.2, stairFloorHeight: 3.25, lthr })

describe('intervalsText', () => {
  it('writes steps, a repeat block and pace targets', () => {
    expect(text('10m wu, 5x3m/2m @ 4:00/km, 10m cd')).toBe(
      ['- Warmup 10m Z1 HR', '', '5x', '- 3m 4:00/km Pace', '- Recovery 2m Z1 HR', '', '- Cooldown 10m Z1 HR'].join('\n'),
    )
  })

  it('writes power, zone and heart-rate targets for the sport', () => {
    expect(text('20m @ 200-240w', 'ride')).toBe('- 20m 200-240w')
    expect(text('20m @ Z2', 'ride')).toBe('- 20m Z2')
    expect(text('20m @ Z2-Z3', 'run')).toBe('- 20m Z2-Z3 Pace')
    expect(text('20m @ Z2', 'stair')).toBe('- 20m Z2 HR')
    expect(text('20m @ 150-160bpm', 'run', 170)).toBe('- 20m 88-94% LTHR')
    expect(text('20m @ 150-160bpm', 'run')).toBe('- HR 150 to 160 20m Z2 HR')
    expect(text('800mtr @ 12-15km/h', 'run')).toBe('- 800mtr 4:00/km-5:00/km Pace')
    expect(text('2km easy', 'run')).toBe('- 2km Z2 HR')
  })

  it('puts what intervals.icu has no field for in the cue, without % signs', () => {
    expect(text('30m @ 15%, 8.5km/h, rpe7', 'treadmill')).toBe('- incline 15 RPE 7 30m 7:04/km Pace')
    expect(text('10m @ lvl8, 70spm', 'stair')).toBe('- level 8 70 spm 10m Z2 HR')
    expect(text('100fl', 'stair')).toBe('100 floors')
  })

  it('writes outer repeats out, keeping the innermost', () => {
    const out = text('3x10x40/20 r3m')
    expect(out.split('\n').filter((l) => l === '10x')).toHaveLength(3)
    expect(out).toContain('10x\n- 40s Z4 HR\n- Recovery 20s Z1 HR\n\n- Recovery 3m Z1 HR\n\n10x')
    expect(out).not.toMatch(/^3x$/m)
  })

  it('drops the final recovery like expand does', () => {
    expect(text('5x3m/2m -r')).toBe(['4x', '- 3m Z4 HR', '- Recovery 2m Z1 HR', '', '- 3m Z4 HR'].join('\n'))
    // As many step lines, once repeats are multiplied out, as expand gives steps.
    for (const s of ['3x(10x40/20, 5m easy) -r', '3x(10x40/20 -r, 5m easy)', '2x(3x1m/1m -r) r3m', '1x5m/1m -r']) {
      let count = 0
      let times = 1
      for (const line of text(s).split('\n')) {
        if (/^\d+x$/.test(line)) times = Number(line.slice(0, -1))
        else if (!line) times = 1
        else count += times
      }
      expect([s, count]).toEqual([s, expand(parseWorkout(s).blocks).length])
    }
  })

  // intervals.icu draws nothing for a step without a target.
  it('gives a step without a target the zone this app gives it, as a power or heart-rate zone', () => {
    expect(text('10m wu, 4x3m/2m, 5m easy, 10m cd', 'ride')).toBe(
      ['- Warmup 10m Z1', '', '4x', '- 3m Z4', '- Recovery 2m Z1', '', '- 5m Z2', '- Cooldown 10m Z1'].join('\n'),
    )
    expect(text('20m @ rpe7', 'stair')).toBe('- RPE 7 20m Z4 HR')
    expect(intervalsText(parseWorkout('3x5m/1m').blocks, 'run', undefined, 3).split('\n')[1]).toBe('- 5m Z1 HR')
  })

  it('leaves pauses out', () => {
    expect(text('10m, 5m pause, 10m')).toBe('- 10m Z2 HR\n- 10m Z2 HR')
  })
})

describe('intervalsEvent', () => {
  const blocks = parseWorkout('10m wu, 5x3m/2m @ Z4, 10m cd').blocks

  it('describes the workout as a calendar event', () => {
    expect(intervalsEvent({ id: 'w1', date: '2026-10-06', sport: 'treadmill', blocks }, 'kmh')).toMatchObject({
      category: 'WORKOUT',
      start_date_local: '2026-10-06T00:00:00',
      type: 'VirtualRun',
      indoor: true,
      name: '5×3m/2m @ Z4',
      external_id: 'workout-tracker:w1',
    })
    expect(workoutIdOf('workout-tracker:w1')).toBe('w1')
    expect(workoutIdOf('someone-elses')).toBeUndefined()
  })

  it('sends the total time of a workout without steps', () => {
    const e = intervalsEvent({ id: 'w2', date: '2026-10-06', sport: 'ride', title: 'Easy spin', blocks: [], duration: 3600 }, 'kmh')
    expect(e).toMatchObject({ type: 'Ride', name: 'Easy spin', description: '', moving_time: 3600 })
  })
})
