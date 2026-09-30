// Sign-in state helpers around the Supabase client.
import { clearLocalData, db } from '../db/db'
import { CALLBACK_PATH, forgetStravaToken } from '../strava/auth'
import { syncNow } from '../sync/engine'
import { supabase } from '../supabase'

let finishing: Promise<string | undefined> | null = null

/**
 * Finishes a magic-link redirect, if this load is one: signs in with its `?code=`, or returns the error it
 * carries. The Strava callback also has a `code` parameter, so it's left alone.
 */
export function finishMagicLink(): Promise<string | undefined> {
  // Once per load; StrictMode runs effects twice and a code can only be exchanged once.
  finishing ??= (async () => {
    const url = new URL(window.location.href)
    if (url.pathname === CALLBACK_PATH) return
    const hash = new URLSearchParams(url.hash.slice(1))
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error_description') ?? hash.get('error_description')
    if (!code && !error) return
    window.history.replaceState(null, '', url.pathname)
    if (error) return error
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code!)
    // An expired or reused link; the emailed code may still work.
    return exchangeError ? 'That sign-in link has expired or was already used. Request a new one.' : undefined
  })()
  return finishing
}

/**
 * Signs out and removes this account's data from the browser. Pushes first; if changes still can't be sent
 * (offline), asks before dropping them. Returns false if the user cancelled.
 */
export async function signOut(): Promise<boolean> {
  await syncNow()
  const pending = await db.outbox.count()
  if (pending) {
    const changes = pending === 1 ? '1 change hasn’t' : `${pending} changes haven’t`
    if (!confirm(`${changes} synced yet and will be lost. Sign out anyway?`)) return false
  }
  await supabase.auth.signOut({ scope: 'local' })
  forgetStravaToken()
  await clearLocalData()
  return true
}
