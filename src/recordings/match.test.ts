import { describe, expect, it } from 'vitest'
import type { Recording, Workout } from '../model/types'
import { autoLinks, newLink } from './match'

const workout = (id: string, date: string, sport: Workout['sport'], duration: number, extra: Partial<Workout> = {}): Workout => ({
  id, date, sport, duration, rawText: '', blocks: [], createdAt: 0, updatedAt: 0, ...extra,
})

const recording = (id: string, localDate: string, sport: Recording['sport'], elapsed: number, startTime = `${localDate}T07:00:00Z`): Recording => ({
  id, localDate, sport, elapsed, startTime, rawSport: sport, laps: [], updatedAt: 0,
})

const links = (ws: Workout[], rs: Recording[]) => autoLinks(ws, rs, (w) => w.duration ?? 0)

describe('autoLinks', () => {
  it('links a unique same-day match', () => {
    expect(links([workout('w', '2026-09-29', 'treadmill', 3200)], [recording('r', '2026-09-29', 'run', 3300)])).toEqual([
      { workoutId: 'w', recordingId: 'r' },
    ])
  })

  it('ignores other days and incompatible sports', () => {
    const ws = [workout('w', '2026-09-29', 'stair', 1800)]
    expect(links(ws, [recording('a', '2026-09-30', 'stair', 1800), recording('b', '2026-09-29', 'run', 1800)])).toEqual([])
    expect(links([workout('w', '2026-09-29', 'ride', 1800)], [recording('r', '2026-09-29', 'run', 1800)])).toEqual([])
  })

  it("doesn't link a recording the user unlinked from that workout", () => {
    const rs = [recording('r1', '2026-09-29', 'run', 2700)]
    expect(links([workout('w', '2026-09-29', 'run', 2700, { unlinked: 'r1' })], rs)).toEqual([])
    expect(links([workout('w', '2026-09-29', 'run', 2700, { unlinked: 'r0' })], rs)).toHaveLength(1)
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
      recording: newLink('r1', 'manual'),
    })
    const rs = [recording('r1', '2026-09-29', 'run', 2700), recording('r2', '2026-09-29', 'run', 2600)]
    expect(links([linked, workout('w2', '2026-09-29', 'run', 2650)], rs)).toEqual([{ workoutId: 'w2', recordingId: 'r2' }])
  })
})
