// Strava OAuth in the browser. The tokens live on the server (server/strava.ts, table strava_tokens), because
// refresh tokens rotate and every device shares them. The browser asks /api/strava/token for a current access
// token and keeps it in memory; data calls then go straight to Strava.
import { db } from '../db/db'
import { supabase } from '../supabase'

const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID as string | undefined
const STATE_KEY = 'strava-oauth-state'
export const CALLBACK_PATH = '/strava/callback'
/** Ask for a new access token when this one has less than this long left, in seconds. */
const REFRESH_MARGIN = 300

class NotConnectedError extends Error {
  constructor() {
    super('Strava is not connected')
  }
}

export function stravaConfigured(): boolean {
  return !!CLIENT_ID
}

/** The Strava consent page URL. Stores a random state to check on the way back. */
export function connectUrl(): string {
  const state = crypto.randomUUID()
  sessionStorage.setItem(STATE_KEY, state)
  const params = new URLSearchParams({
    client_id: CLIENT_ID ?? '',
    redirect_uri: `${window.location.origin}${CALLBACK_PATH}`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state,
  })
  return `https://www.strava.com/oauth/authorize?${params}`
}

class ServerError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Calls /api/strava/:action as the signed-in user. */
async function callServer<T>(action: 'exchange' | 'token' | 'revoke', body: Record<string, string> = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session) throw new ServerError(401, 'Sign in first')
  const res = await fetch(`/api/strava/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ServerError(res.status, json.error ?? `Strava ${action} failed (${res.status})`)
  return json as T
}

/**
 * Finishes the OAuth redirect if the current URL is the callback. Returns null
 * when it isn't, otherwise whether connecting worked.
 */
export async function handleCallback(): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (window.location.pathname !== CALLBACK_PATH) return null
  const params = new URLSearchParams(window.location.search)
  const expected = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(STATE_KEY)
  window.history.replaceState(null, '', '/')

  if (params.get('error')) return { ok: false, error: 'Strava access was not granted.' }
  if (!expected || params.get('state') !== expected) return { ok: false, error: 'Strava sign-in expired; try again.' }
  const scope = params.get('scope') ?? ''
  if (!scope.split(',').some((s) => s === 'activity:read' || s === 'activity:read_all')) {
    return { ok: false, error: 'Activity access is needed; tick "View data about your activities" when connecting.' }
  }
  try {
    const a = await callServer<{ athleteId: number; athleteName: string; scope: string }>('exchange', {
      code: params.get('code') ?? '',
      scope,
    })
    cached = null
    await db.stravaConnection.put({ id: 'strava', athleteId: a.athleteId, athleteName: a.athleteName, scope: a.scope })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Updates the local record of the Strava connection from the server, e.g. after connecting on another device. */
export async function loadStravaConnection(): Promise<void> {
  const { data, error } = await supabase.from('strava_accounts').select('athlete_id, athlete_name, scope').maybeSingle()
  if (error) return // Offline: keep what we have.
  if (!data) {
    await db.stravaConnection.clear()
    return
  }
  await db.stravaConnection.put({ id: 'strava', athleteId: data.athlete_id, athleteName: data.athlete_name ?? '', scope: data.scope })
}

let cached: { token: string; expiresAt: number } | null = null
let fetching: Promise<{ token: string; expiresAt: number }> | null = null

/** A valid access token from the server, which refreshes it with Strava when needed. */
export async function getAccessToken(now = Date.now()): Promise<string> {
  if (!(await db.stravaConnection.get('strava'))) throw new NotConnectedError()
  if (cached && cached.expiresAt - REFRESH_MARGIN > now / 1000) return cached.token
  fetching ??= callServer<{ access_token: string; expires_at: number }>('token')
    .then((t) => (cached = { token: t.access_token, expiresAt: t.expires_at }))
    .catch(async (e) => {
      // Disconnected elsewhere, or access revoked on Strava.
      if (e instanceof ServerError && e.status === 410) {
        await db.stravaConnection.clear()
        throw new NotConnectedError()
      }
      throw e
    })
    .finally(() => (fetching = null))
  return (await fetching).token
}

/** Forgets the in-memory access token, on sign-out. */
export function forgetStravaToken() {
  cached = null
}

/** Revokes access and forgets tokens. Recordings and links stay. */
export async function disconnectStrava(): Promise<void> {
  await callServer('revoke').catch(() => undefined)
  cached = null
  await db.transaction('rw', db.stravaConnection, db.stravaWeekFetch, async () => {
    await db.stravaConnection.clear()
    await db.stravaWeekFetch.clear()
  })
}
