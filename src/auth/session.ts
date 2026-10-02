// Sign-in state helpers around the Supabase client.
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js'
import { clearLocalData, db } from '../db/db'
import { CALLBACK_PATH, forgetStravaToken } from '../strava/auth'
import { syncNow } from '../sync/engine'
import { supabase } from '../supabase'

let finishing: Promise<string | undefined> | null = null

/** What a magic-link redirect put in the URL. */
function linkParams(): { code?: string | null; error?: string | null } {
  const url = new URL(window.location.href)
  if (url.pathname === CALLBACK_PATH) return {}
  const hash = new URLSearchParams(url.hash.slice(1))
  return {
    code: url.searchParams.get('code'),
    error: url.searchParams.get('error_description') ?? hash.get('error_description'),
  }
}

/** Whether this load is a sign-in link still to be exchanged, which may sign in a different user. */
export function isSignInLink(): boolean {
  return !!linkParams().code
}

/**
 * The session, once the client has loaded it. Offline with an expired access token the client can't renew it
 * and reports none, while keeping it stored; that is `'offline'`, not signed out.
 */
export async function readSession(): Promise<Session | 'offline' | null> {
  const { data, error } = await supabase.auth.getSession()
  return data.session ?? (error && isAuthRetryableFetchError(error) ? 'offline' : null)
}

/**
 * Reports how a magic-link redirect went, if this load is one. The Supabase client exchanges the link's `?code=`
 * itself (`detectSessionInUrl`) and removes it from the URL when that works; this returns the error the link
 * carries, or says so when the code is still there because the exchange failed. The Strava callback also has a
 * `code` parameter, so it's left alone.
 */
export function finishMagicLink(): Promise<string | undefined> {
  finishing ??= (async () => {
    // Waits for the client to finish with the URL.
    await supabase.auth.getSession()
    const { code, error } = linkParams()
    if (!code && !error) return
    window.history.replaceState(null, '', window.location.pathname)
    // An expired or reused link, or one opened in another browser; the emailed code may still work.
    return error ?? 'That sign-in link has expired or was already used. Request a new one, or use the code.'
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
  await endSession()
  return true
}

async function endSession() {
  await supabase.auth.signOut({ scope: 'local' })
  forgetStravaToken()
  await clearLocalData()
}

/**
 * Signs out if the server no longer knows the session's user (the account was deleted, or the local stack was
 * reset), since nothing could sync. Other failures, such as being offline, leave the session alone.
 */
export async function dropSessionIfUserGone() {
  const { error } = await supabase.auth.getUser()
  if (error?.code === 'user_not_found') await endSession()
}
