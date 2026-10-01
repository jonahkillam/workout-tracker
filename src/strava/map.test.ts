import { describe, expect, it } from 'vitest'
import { lapsFromStrava, recordingFromSummary, sportFromStrava, streamsFromStrava } from './map'

describe('sportFromStrava', () => {
  it('maps Strava sport types', () => {
    expect(sportFromStrava('Run')).toBe('run')
    expect(sportFromStrava('Run', true)).toBe('treadmill')
    expect(sportFromStrava('VirtualRun')).toBe('treadmill')
    expect(sportFromStrava('TrailRun')).toBe('run')
    expect(sportFromStrava('StairStepper')).toBe('stair')
    expect(sportFromStrava('GravelRide')).toBe('ride')
    expect(sportFromStrava('WeightTraining')).toBe('other')
  })
})

describe('recordingFromSummary', () => {
  const summary = {
    id: 42,
    name: 'Morning Run',
    sport_type: 'Run',
    trainer: true,
    start_date: '2026-09-29T05:10:00Z',
    start_date_local: '2026-09-29T07:10:00Z',
    elapsed_time: 3300,
    moving_time: 3200,
    distance: 6100,
    total_elevation_gain: 0,
    average_heartrate: 151.2,
    max_heartrate: 178,
  }

  it('uses the local date and maps the summary', () => {
    const r = recordingFromSummary(summary, undefined, 1000)
    expect(r).toMatchObject({
      stravaId: 42, localDate: '2026-09-29', sport: 'treadmill', rawSport: 'Run', elapsed: 3300,
      avgHr: 151.2, maxHr: 178, laps: [], updatedAt: 1000,
    })
  })

  it('keeps identity and details when updating', () => {
    const first = recordingFromSummary(summary, undefined, 1000)
    const withLaps = { ...first, laps: [{ start: 0, duration: 60 }], detailsFetched: true, autoLogged: true }
    const again = recordingFromSummary({ ...summary, name: 'Renamed' }, withLaps, 2000)
    expect(again).toMatchObject({ id: 'strava-42', name: 'Renamed', laps: [{ start: 0, duration: 60 }], detailsFetched: true, autoLogged: true, updatedAt: 2000 })
  })

  it('returns the existing recording itself when the summary is unchanged', () => {
    const first = { ...recordingFromSummary(summary, undefined, 1000), autoLogged: true }
    expect(recordingFromSummary(summary, first, 2000)).toBe(first)
    expect(recordingFromSummary({ ...summary, moving_time: 3100 }, first, 2000)).not.toBe(first)
  })
})

describe('streams and laps', () => {
  it('converts streams to typed arrays', () => {
    const s = streamsFromStrava('r', {
      time: { data: [0, 1, 2, 5] },
      heartrate: { data: [120, 121, 125, 130] },
      velocity_smooth: { data: [2.5, 2.6, 2.6, 2.7] },
    })!
    expect(s.t).toEqual(Uint32Array.from([0, 1, 2, 5]))
    expect(s.hr).toEqual(Uint8Array.from([120, 121, 125, 130]))
    expect(s.speed?.[3]).toBeCloseTo(2.7)
    expect(s.cadence).toBeUndefined()
    expect(streamsFromStrava('r', {})).toBeUndefined()
  })

  it('turns lap indexes into start seconds', () => {
    const time = [0, 10, 20, 35, 50]
    expect(lapsFromStrava([
      { start_index: 0, end_index: 2, elapsed_time: 20, distance: 100 },
      { start_index: 3, end_index: 4, elapsed_time: 15 },
    ], time)).toEqual([
      { start: 0, duration: 20, distance: 100 },
      { start: 35, duration: 15, distance: undefined },
    ])
    expect(lapsFromStrava([{ elapsed_time: 60 }, { elapsed_time: 30 }]).map((l) => l.start)).toEqual([0, 60])
  })
})
