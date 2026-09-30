import { describe, expect, it } from 'vitest'
import type { Recording, Workout } from '../model/types'
import { autoLinks, findSameActivity, sportsCompatible } from './match'

const workout = (id: string, date: string, sport: Workout['sport'], duration: number, extra: Partial<Workout> = {}): Workout => ({
  id, date, sport, duration, rawText: '', blocks: [], createdAt: 0, updatedAt: 0, ...extra,
})

const recording = (id: string, localDate: string, sport: Recording['sport'], elapsed: number, startTime = `${localDate}T07:00:00Z`): Recording => ({
  id, localDate, sport, elapsed, startTime, rawSport: sport, laps: [], importedAt: 0, updatedAt: 0,
})

const links = (ws: Workout[], rs: Recording[]) => autoLinks(ws, rs, (w) => w.duration ?? 0)

describe('sportsCompatible', () => {
  it('pairs treadmill and run but not other sports', () => {
    expect(sportsCompatible('treadmill', 'run')).toBe(true)
    expect(sportsCompatible('run', 'treadmill')).toBe(true)
    expect(sportsCompatible('stair', 'run')).toBe(false)
    expect(sportsCompatible('ride', 'ride')).toBe(true)
  })
})

describe('autoLinks', () => {
  it('links a unique same-day match', () => {
    expect(links([workout('w', '2026-09-29', 'treadmill', 3200)], [recording('r', '2026-09-29', 'run', 3300)])).toEqual([
      { workoutId: 'w', recordingId: 'r' },
    ])
  })

  it('ignores other days and incompatible sports', () => {
    const ws = [workout('w', '2026-09-29', 'stair', 1800)]
    expect(links(ws, [recording('a', '2026-09-30', 'stair', 1800), recording('b', '2026-09-29', 'run', 1800)])).toEqual([])
  })

  it('uses duration to break a tie only when it is clear', () => {
    const ws = [workout('easy', '2026-09-29', 'run', 2700), workout('long', '2026-09-29', 'run', 5400)]
    const rs = [recording('r1', '2026-09-29', 'run', 2750), recording('r2', '2026-09-29', 'run', 5300)]
    expect(links(ws, rs)).toEqual([
      { workoutId: 'easy', recordingId: 'r1' },
      { workoutId: 'long', recordingId: 'r2' },
    ])
    // Two near-identical runs: ambiguous, so nothing is linked.
    const twins = [recording('r1', '2026-09-29', 'run', 2700), recording('r2', '2026-09-29', 'run', 2710)]
    expect(links([workout('easy', '2026-09-29', 'run', 2705)], twins)).toEqual([])
  })

  it('never touches existing links', () => {
    const linked = workout('w1', '2026-09-29', 'run', 2700, {
      recording: { id: 'r1', linkedBy: 'manual', alignment: { method: 'offset', offset: 0 } },
    })
    const rs = [recording('r1', '2026-09-29', 'run', 2700), recording('r2', '2026-09-29', 'run', 2600)]
    expect(links([linked, workout('w2', '2026-09-29', 'run', 2650)], rs)).toEqual([{ workoutId: 'w2', recordingId: 'r2' }])
  })
})

describe('findSameActivity', () => {
  it('matches start times within a minute', () => {
    const rs = [recording('fit', '2026-09-29', 'run', 3000, '2026-09-29T07:00:30Z')]
    expect(findSameActivity(rs, '2026-09-29T07:00:00Z')?.id).toBe('fit')
    expect(findSameActivity(rs, '2026-09-29T07:05:00Z')).toBeUndefined()
  })
})
