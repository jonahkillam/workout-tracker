// Pure conversions from Strava API responses to the app's Recording model.
import type { Lap, Recording, RecordingStreams, Sport } from '../model/types'

/** The fields of Strava's SummaryActivity that the app uses. */
export interface StravaActivity {
  id: number
  name?: string
  sport_type?: string
  type?: string
  start_date: string
  start_date_local: string
  elapsed_time: number
  moving_time?: number
  distance?: number
  total_elevation_gain?: number
  average_heartrate?: number
  max_heartrate?: number
  trainer?: boolean
}

export interface StravaStream {
  data: number[]
}

/** Streams response with `key_by_type=true`. */
export type StravaStreams = Partial<
  Record<'time' | 'heartrate' | 'velocity_smooth' | 'cadence' | 'watts' | 'altitude' | 'distance', StravaStream>
>

export interface StravaLap {
  start_index?: number
  end_index?: number
  elapsed_time: number
  distance?: number
}

export const STREAM_KEYS = ['time', 'heartrate', 'velocity_smooth', 'cadence', 'watts', 'altitude', 'distance'] as const

export function sportFromStrava(sportType: string, trainer = false): Sport {
  if (sportType === 'VirtualRun' || (sportType === 'Run' && trainer)) return 'treadmill'
  if (sportType === 'Run' || sportType === 'TrailRun') return 'run'
  if (sportType === 'StairStepper') return 'stair'
  if (sportType.endsWith('Ride')) return 'ride'
  return 'other'
}

/**
 * Builds a new recording, or updates `existing` with fresh summary data. Returns `existing` itself when the
 * summary hasn't changed, so an unchanged activity isn't written (and pushed) again.
 */
export function recordingFromSummary(a: StravaActivity, existing?: Recording, now = Date.now()): Recording {
  const rawSport = a.sport_type ?? a.type ?? 'Workout'
  const summary = {
    stravaId: a.id,
    // Normalised (Strava leaves out milliseconds), so it compares equal to the copy read back from the server.
    startTime: new Date(a.start_date).toISOString(),
    // start_date_local is local wall-clock time written with a Z suffix.
    localDate: a.start_date_local.slice(0, 10),
    sport: sportFromStrava(rawSport, a.trainer),
    rawSport,
    name: a.name,
    elapsed: a.elapsed_time,
    moving: a.moving_time,
    distance: a.distance,
    elevationGain: a.total_elevation_gain,
    avgHr: a.average_heartrate,
    maxHr: a.max_heartrate,
  }
  if (existing && (Object.keys(summary) as (keyof typeof summary)[]).every((k) => existing[k] === summary[k])) return existing
  // The id comes from the Strava id so every device syncing the same activity writes the same row.
  return { laps: [], ...existing, id: `strava-${a.id}`, ...summary, updatedAt: now }
}

export function streamsFromStrava(recordingId: string, s: StravaStreams): RecordingStreams | undefined {
  if (!s.time?.data.length) return undefined
  return {
    recordingId,
    t: Uint32Array.from(s.time.data),
    hr: s.heartrate && Uint8Array.from(s.heartrate.data),
    speed: s.velocity_smooth && Float32Array.from(s.velocity_smooth.data),
    cadence: s.cadence && Uint8Array.from(s.cadence.data),
    power: s.watts && Uint16Array.from(s.watts.data),
    altitude: s.altitude && Float32Array.from(s.altitude.data),
    distance: s.distance && Float32Array.from(s.distance.data),
  }
}

/**
 * Laps with start times in seconds. Strava gives laps as indexes into the
 * streams; without a time stream, starts are summed from lap durations.
 */
export function lapsFromStrava(laps: StravaLap[], time?: ArrayLike<number>): Lap[] {
  let cursor = 0
  return laps.map((l) => {
    const start = time && l.start_index !== undefined && l.start_index < time.length ? time[l.start_index] : cursor
    cursor = start + l.elapsed_time
    return { start, duration: l.elapsed_time, distance: l.distance }
  })
}
