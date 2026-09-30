// Strava API v3 reads. These go straight from the browser: the API allows CORS.
import { getAccessToken } from './auth'
import { STREAM_KEYS, type StravaActivity, type StravaLap, type StravaStreams } from './map'

const BASE = 'https://www.strava.com/api/v3'

export class RateLimitedError extends Error {
  constructor() {
    super('Strava rate limit reached; try again in 15 minutes.')
  }
}

export class StravaApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface RateUsage {
  /** Requests used in the current 15-minute window and today. */
  used: [number, number]
  limit: [number, number]
}

/** Read-limit usage from the most recent response, if Strava reported it. */
export let readUsage: RateUsage | undefined

function pair(header: string | null): [number, number] | undefined {
  const parts = header?.split(',').map(Number)
  return parts?.length === 2 && parts.every(Number.isFinite) ? [parts[0], parts[1]] : undefined
}

export async function stravaGet<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const token = await getAccessToken()
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const res = await fetch(`${BASE}${path}${query.size ? `?${query}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const used = pair(res.headers.get('x-readratelimit-usage'))
  const limit = pair(res.headers.get('x-readratelimit-limit'))
  if (used && limit) readUsage = { used, limit }
  if (res.status === 429) throw new RateLimitedError()
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new StravaApiError(res.status, body.message ?? `Strava request failed (${res.status})`)
  }
  return (await res.json()) as T
}

/** All activities that started between two epoch-second times. */
export async function listActivities(after: number, before: number): Promise<StravaActivity[]> {
  const all: StravaActivity[] = []
  for (let page = 1; ; page++) {
    const batch = await stravaGet<StravaActivity[]>('/athlete/activities', { after, before, page, per_page: 200 })
    all.push(...batch)
    if (batch.length < 200) return all
  }
}

/** Streams for an activity; empty for activities without any (e.g. manual entries). */
export async function getStreams(id: number): Promise<StravaStreams> {
  try {
    return await stravaGet<StravaStreams>(`/activities/${id}/streams`, { keys: STREAM_KEYS.join(','), key_by_type: true })
  } catch (e) {
    if (e instanceof StravaApiError && e.status === 404) return {}
    throw e
  }
}

export function getLaps(id: number): Promise<StravaLap[]> {
  return stravaGet<StravaLap[]>(`/activities/${id}/laps`)
}
