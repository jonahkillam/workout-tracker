// Strava OAuth in the browser. The code exchange and refreshes go through
// /api/strava/* (server/strava.ts), which holds the client secret.
import { db } from '../db/db'
import type { StravaAuth } from '../model/types'

const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID as string | undefined
const STATE_KEY = 'strava-oauth-state'
export const CALLBACK_PATH = '/strava/callback'
/** Refresh when the access token has less than this long left, in seconds. */
const REFRESH_MARGIN = 300

export class NotConnectedError extends Error {
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

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_at: number
  athlete?: { id: number; firstname?: string; lastname?: string }
}

async function postToken(action: 'exchange' | 'refresh', body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`/api/strava/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? data.message ?? `Strava ${action} failed (${res.status})`)
  return data as TokenResponse
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
    const t = await postToken('exchange', { code: params.get('code') ?? '' })
    const athlete = t.athlete
    await db.stravaAuth.put({
      id: 'strava',
      athleteId: athlete?.id ?? 0,
      athleteName: [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' '),
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: t.expires_at,
      scope,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

let refreshing: Promise<StravaAuth> | null = null

async function refresh(auth: StravaAuth): Promise<StravaAuth> {
  const t = await postToken('refresh', { refresh_token: auth.refreshToken })
  // Refresh tokens rotate: always keep the newest one.
  const next = { ...auth, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at }
  await db.stravaAuth.put(next)
  return next
}

/** A valid access token, refreshing it first if it's about to expire. */
export async function getAccessToken(now = Date.now()): Promise<string> {
  const auth = await db.stravaAuth.get('strava')
  if (!auth) throw new NotConnectedError()
  if (auth.expiresAt - REFRESH_MARGIN > now / 1000) return auth.accessToken
  // One refresh at a time: a second call would use an already-rotated refresh token.
  refreshing ??= refresh(auth).finally(() => (refreshing = null))
  return (await refreshing).accessToken
}

/** Revokes access and forgets tokens. Recordings and links stay. */
export async function disconnectStrava(): Promise<void> {
  const auth = await db.stravaAuth.get('strava')
  if (auth) {
    await fetch('/api/strava/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: auth.accessToken }),
    }).catch(() => undefined)
  }
  await db.transaction('rw', db.stravaAuth, db.stravaWeekFetch, async () => {
    await db.stravaAuth.clear()
    await db.stravaWeekFetch.clear()
  })
}
