// intervals.icu API calls, straight from the browser (the API allows CORS) with the user's own API key.
import type { IntervalsEvent } from '../export/intervals'

const BASE = 'https://intervals.icu/api/v1'

export class IntervalsError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** An event as intervals.icu returns it; only what the sync compares. */
export interface RemoteEvent extends Partial<IntervalsEvent> {
  id: number
}

/** The calls the sync needs, so tests can stand in for the server. */
export interface IntervalsApi {
  /** Planned workouts between two local dates, inclusive. */
  list(oldest: string, newest: string): Promise<RemoteEvent[]>
  create(events: IntervalsEvent[]): Promise<void>
  update(id: number, event: IntervalsEvent): Promise<void>
  remove(ids: number[]): Promise<void>
}

async function call<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 || res.status === 403) throw new IntervalsError(res.status, 'intervals.icu rejected the API key.')
  if (res.status === 429) throw new IntervalsError(429, 'intervals.icu rate limit reached; it will try again later.')
  if (!res.ok) throw new IntervalsError(res.status, `intervals.icu request failed (${res.status})`)
  return (await res.json().catch(() => undefined)) as T
}

/** The athlete the key belongs to: checks the key when connecting. */
export async function getAthlete(apiKey: string): Promise<{ id: string; name?: string }> {
  return call(apiKey, 'GET', '/athlete/0')
}

// Athlete 0 is whoever the key belongs to.
export function intervalsApi(apiKey: string): IntervalsApi {
  return {
    list: (oldest, newest) => call(apiKey, 'GET', `/athlete/0/events?oldest=${oldest}&newest=${newest}&category=WORKOUT`),
    create: (events) => call(apiKey, 'POST', '/athlete/0/events/bulk', events),
    update: (id, event) => call(apiKey, 'PUT', `/athlete/0/events/${id}`, event),
    remove: (ids) => call(apiKey, 'PUT', '/athlete/0/events/bulk-delete', ids.map((id) => ({ id }))),
  }
}
