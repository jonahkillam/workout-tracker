import { describe, expect, it } from 'vitest'
import type { Block, Step } from '../model/types'
import { expand, withSpeedUnit } from '../model/tree'
import { parseWorkout } from './parser'
import { serializeBlocks } from './serialize'

const step = (s: Partial<Step>): Step => ({ type: 'step', kind: 'steady', targets: {}, ...s })

function parseOk(src: string): Block[] {
  const r = parseWorkout(src)
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  return r.blocks
}

describe('parseWorkout', () => {
  it('parses the treadmill incline example', () => {
    const blocks = parseOk('10m wu 3x10x40/20 @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd')
    expect(blocks).toEqual([
      step({ kind: 'wu', duration: 600 }),
      {
        type: 'repeat',
        count: 3,
        children: [
          {
            type: 'repeat',
            count: 10,
            children: [
              step({
                kind: 'work',
                duration: 40,
                targets: { incline: { min: 15, max: 15 }, speed: { min: 8.3, max: 8.8 } },
              }),
              step({
                kind: 'rest',
                duration: 20,
                targets: { incline: { min: 15, max: 15 }, speed: { min: 6.5, max: 7 } },
              }),
            ],
          },
        ],
      },
      step({ kind: 'cd', duration: 600 }),
    ])
  })

  it('splits incline between work and rest', () => {
    const [r] = parseOk('4x2m/1m @ 15%//5%, 7km/h') as [Extract<Block, { type: 'repeat' }>]
    expect(r.children).toEqual([
      step({ kind: 'work', duration: 120, targets: { incline: { min: 15, max: 15 }, speed: { min: 7, max: 7 } } }),
      step({ kind: 'rest', duration: 60, targets: { incline: { min: 5, max: 5 } } }),
    ])
  })

  it('propagates units across ranges and splits', () => {
    const [r] = parseOk('5x1m/1m @ 8.3-8.8//6.5-7km/h') as [Extract<Block, { type: 'repeat' }>]
    expect((r.children[0] as Step).targets.speed).toEqual({ min: 8.3, max: 8.8 })
    expect((r.children[1] as Step).targets.speed).toEqual({ min: 6.5, max: 7 })
  })

  it('parses distances, paces and set rests', () => {
    const [r] = parseOk('3x(4x400mtr/90s) r3m @ 3:50-4:00/km') as [Extract<Block, { type: 'repeat' }>]
    expect(r.count).toBe(3)
    expect(r.children[1]).toEqual(step({ kind: 'rest', duration: 180 }))
    const inner = r.children[0] as Extract<Block, { type: 'repeat' }>
    const work = inner.children[0] as Step
    expect(work.distance).toBe(400)
    expect(work.targets.asPace).toBe(true)
    expect(work.targets.speed!.min).toBeCloseTo(15, 5)
    expect(work.targets.speed!.max).toBeCloseTo(15.652, 3)
  })

  it('treats "w/" as rest after each rep', () => {
    const [r] = parseOk('6x800mtr w/ 90s @ Z4') as [Extract<Block, { type: 'repeat' }>]
    expect(r.children).toEqual([
      step({ kind: 'work', distance: 800, targets: { zone: { min: 4, max: 4 } } }),
      step({ kind: 'rest', duration: 90 }),
    ])
  })

  it('parses compound durations, stairs and machine targets', () => {
    expect(parseOk('1h5m easy @ Z2')).toEqual([step({ duration: 3900, targets: { zone: { min: 2, max: 2 } } })])
    expect(parseOk('30m @ lvl8, 70spm')).toEqual([
      step({ duration: 1800, targets: { level: { min: 8, max: 8 }, stepRate: { min: 70, max: 70 } } }),
    ])
    expect(parseOk('100fl')).toEqual([step({ floors: 100 })])
    expect(parseOk('45m @ 200-220w, rpe6')).toEqual([
      step({ duration: 2700, targets: { power: { min: 200, max: 220 }, rpe: 6 } }),
    ])
  })

  it('assumes metres for large bare rep bodies with a warning', () => {
    const r = parseWorkout('8x400')
    expect((r.blocks[0] as Extract<Block, { type: 'repeat' }>).children[0]).toEqual(
      step({ kind: 'work', distance: 400 }),
    )
    expect(r.diagnostics).toMatchObject([{ severity: 'warning' }])
  })

  it('reports unrecognised text with its position', () => {
    const r = parseWorkout('10m wu, banana, 5m cd')
    expect(r.blocks).toHaveLength(2)
    expect(r.diagnostics).toMatchObject([{ severity: 'error', start: 8, end: 14 }])
  })
})

describe('dropping the final rest', () => {
  it('parses -r before or after targets', () => {
    for (const src of ['5x3m/2m -r @ Z4', '5x3m/2m @ Z4 -r']) {
      const [r] = parseOk(src) as [Extract<Block, { type: 'repeat' }>]
      expect(r.skipLastRest).toBe(true)
      expect(r.children).toHaveLength(2)
    }
  })

  it('drops only the repeat\'s own final recovery', () => {
    const steps = expand(parseOk('3x10x40/20 r3m -r'))
    // 30 work + 30 rests + 3 set rests, minus the final set rest; the 20s before it stays.
    expect(steps).toHaveLength(62)
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'rest', duration: 20 })
    expect(expand(parseOk('3x10x40/20 r3m'))).toHaveLength(63)
    // Ending in a nested repeat: only the very last recovery goes.
    const nested = expand(parseOk('3x10x40/20 -r'))
    expect(nested).toHaveLength(59)
    expect(nested[nested.length - 1].kind).toBe('work')
  })

  it('applies -r to the repeat it is written on', () => {
    const total = (src: string) => expand(parseOk(src)).reduce((t, st) => t + (st.duration ?? 0), 0)
    const outer =
      '10m wu 6km/h 15% 3x(10x(40s @8.5km/h 15%, 20s 6.7km/h 15%), 5m 6km/h easy 15%)-r, 10m cd 6.5km/h 15%'
    const both =
      '10m wu 6km/h 15% 3x(10x(40s @8.5km/h 15%, 20s 6.7km/h 15%)-r, 5m 6km/h easy 15%)-r, 10m cd 6.5km/h 15%'
    // 10 + 3 × (10 × 1m + 5m) + 10 = 65 min.
    expect(total(outer)).toBe(65 * 60 - 300) // only the last 5m easy
    expect(total(both)).toBe(65 * 60 - 300 - 3 * 20) // plus the last 20s of each set
    const steps = expand(parseOk(outer))
    expect(steps[steps.length - 2]).toMatchObject({ kind: 'rest', duration: 20 })
    for (const src of [outer, both]) expect(parseOk(serializeBlocks(parseOk(src)))).toEqual(parseOk(src))
  })

  it('makes the last unmarked step of a repeat the rest and the others work', () => {
    const kinds = (src: string) =>
      ((parseOk(src)[0] as Extract<Block, { type: 'repeat' }>).children as Step[]).map((c) => c.kind)
    expect(kinds('4x(3m @ 8km/h, 2m @ 5km/h)')).toEqual(['work', 'rest'])
    expect(kinds('4x(3m @ 5km/h, 2m @ 8km/h)')).toEqual(['work', 'rest'])
    expect(kinds('4x(1m, 2m, 3m)')).toEqual(['work', 'work', 'rest'])
    expect(kinds('4x(3m)')).toEqual(['work'])
    // Role words win.
    expect(kinds('4x(3m easy @ 9km/h, 2m @ 5km/h, 1m @ 7km/h)')).toEqual(['steady', 'work', 'rest'])
    expect(kinds('4x(3m, 2m work)')).toEqual(['work', 'work'])
  })

  it('accepts -r after a comma', () => {
    for (const src of ['5x3m/2m @ 15%, 8km/h, -r', '5x3m/2m, -r', '5x3m/2m @ 15%, -r, 10m cd']) {
      const r = parseWorkout(src)
      expect(r.diagnostics).toEqual([])
      expect((r.blocks[0] as Extract<Block, { type: 'repeat' }>).skipLastRest).toBe(true)
    }
    expect(parseWorkout('5x3m/2m @ 15%, -r, 10m cd').blocks).toHaveLength(2)
  })

  it('explains a -r that is not on a repeat', () => {
    expect(parseWorkout('10m cd -r').diagnostics).toMatchObject([
      { severity: 'error', message: '-r only applies to a repeat, e.g. 5x3m/2m -r', start: 7, end: 9 },
    ])
  })

  it('keeps "r3m" as a set rest', () => {
    const [r] = parseOk('4x5m r3m') as [Extract<Block, { type: 'repeat' }>]
    expect(r.skipLastRest).toBeUndefined()
  })
})

describe('speed units', () => {
  it('reads unitless speeds as km/h by default, with a warning', () => {
    const r = parseWorkout('5x1m/1m @ 8.3-8.8//6.5-7')
    const [work, rest] = (r.blocks[0] as Extract<Block, { type: 'repeat' }>).children as Step[]
    expect(work.targets.speed).toEqual({ min: 8.3, max: 8.8 })
    expect(rest.targets.speed).toEqual({ min: 6.5, max: 7 })
    expect(r.diagnostics).toMatchObject([{ severity: 'warning', message: 'No unit — read as km/h' }])
  })

  it('reads unitless speeds as min/km in pace mode', () => {
    const [s] = parseWorkout('20m @ 5.5', { speedUnit: 'pace' }).blocks as Step[]
    expect(s.targets.speed!.min).toBeCloseTo(3600 / 330)
    expect(s.targets.asPace).toBe(true)
  })

  it('always reads mm:ss as a pace', () => {
    const r = parseWorkout('20m @ 5:00')
    const [s] = r.blocks as Step[]
    expect(r.diagnostics).toEqual([])
    expect(s.targets.speed).toEqual({ min: 12, max: 12 })
    expect(s.targets.asPace).toBe(true)
  })

  it('converts a workout between km/h and pace', () => {
    const blocks = parseOk('4x2m/1m @ 12km/h//8km/h')
    expect(serializeBlocks(withSpeedUnit(blocks, 'pace'))).toBe('4x2m/1m @ 5:00/km//7:30/km')
    expect(serializeBlocks(withSpeedUnit(withSpeedUnit(blocks, 'pace'), 'kmh'))).toBe('4x2m/1m @ 12km/h//8km/h')
  })
})

describe('serializeBlocks', () => {
  const cases = [
    '10m wu, 3x10x40/20 @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd',
    '4x2m/1m @ 15%//5%, 7km/h',
    '3x4x400mtr/90s r3m @ 3:50-4:00/km',
    '6x800mtr/90s @ Z4',
    '1h5m @ Z2',
    '30m @ 70spm, lvl8',
    '2x(5m work @ 10%, 8km/h, 2m rec, 1km easy @ 12km/h)',
    '20m @ 5:00/km',
    '100fl @ lvl10',
    '5x3m/2m -r @ 15%, 8km/h',
    '3x10x40/20 r3m -r @ 15%',
    '3x(10x40/20 -r) r3m',
    '2x(5m work @ 10%, 1m rec, 2m easy) -r',
    '1h50m @ 9:40/km, 25m pause, 2h40m @ 9:20/km',
    '10m @ -3.5%, 5:00/km',
    '10m @ 2-4%',
    '4x3m/2m @ 2.5%//-1%, 4:00/km',
    '2x800mtr/90s -r @ 3:20/km, 10m pause, 800mtr work @ 3:20/km',
  ]
  for (const src of cases) {
    it(`round-trips "${src}"`, () => {
      const blocks = parseOk(src)
      const text = serializeBlocks(blocks)
      expect(text).toBe(src)
      expect(parseOk(text)).toEqual(blocks)
    })
  }

  it('writes an untargeted rest as a set rest', () => {
    const blocks = parseOk('3x(40s work @ 15%, 20s rec)')
    expect(serializeBlocks(blocks)).toBe('3x40s r20s @ 15%')
    expect(parseOk('3x40s r20s @ 15%')).toEqual(blocks)
  })

  it('falls back to explicit steps when targets cannot be written as a pair', () => {
    const src = '3x(40s work @ 15%, 20s rec @ 15%, 6km/h)'
    expect(serializeBlocks(parseOk(src))).toBe(src)
  })
})
