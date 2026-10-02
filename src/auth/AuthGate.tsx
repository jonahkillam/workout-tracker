import { useEffect, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { loadStravaConnection } from '../strava/auth'
import { adoptOwner, startSync, syncNow } from '../sync/engine'
import { supabase, supabaseConfigured } from '../supabase'
import { dropSessionIfUserGone, finishMagicLink, isSignInLink, readSession } from './session'
import { SignIn, SignInFrame } from './SignIn'
import { userToOpen, type SessionState } from './user'

/**
 * Shows sign-in until there's a session, then the app for that user. Once signed in, the app opens for the
 * user the local data belongs to without waiting for the session, so it opens at once and with no connection
 * (when an expired session can't be renewed); see `userToOpen`.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>()
  // Whose data the local database held when the page loaded. undefined while loading, null if nobody's.
  const [localOwner, setLocalOwner] = useState<string | null>()
  const [signInLink] = useState(isSignInLink)
  const [linkError, setLinkError] = useState<string>()
  // The user whose data the local database now holds.
  const [owner, setOwner] = useState<string>()
  const userId = userToOpen(session, localOwner, signInLink)

  useEffect(() => {
    if (!supabaseConfigured) return
    void db.syncMeta.get('sync').then((meta) => setLocalOwner(meta?.owner ?? null))
    // The app opened without a session; sync has been failing since.
    let waiting = false
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      // The client also reports no session when it couldn't renew one offline; readSession tells those apart.
      if (s || event === 'SIGNED_OUT') setSession(s)
      if (s && waiting) {
        waiting = false
        // Renewed, some time after the connection came back: send what was written meanwhile.
        void syncNow()
      }
    })
    void finishMagicLink().then(async (error) => {
      setLinkError(error)
      const loaded = await readSession()
      waiting = loaded === 'offline'
      // Not over a session that arrived meanwhile (signed in with the code, or renewed).
      setSession((current) => (current && current !== 'offline' ? current : loaded))
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!userId) return
    // Alongside startup rather than before it, so the app still opens at once (and offline).
    void dropSessionIfUserGone()
    let stop: (() => void) | undefined
    let cancelled = false
    void adoptOwner(userId).then(() => {
      if (cancelled) return
      // Before the app mounts, so its whenReady() waits for the first pull.
      stop = startSync()
      void loadStravaConnection()
      setOwner(userId)
    })
    return () => {
      cancelled = true
      stop?.()
      // Signed out (or another user): the app waits for this user's startup again, even if they sign back in.
      setOwner(undefined)
    }
  }, [userId])

  if (!supabaseConfigured) {
    return (
      <SignInFrame footer={false}>
        <h2>Not configured</h2>
        <p className="signin-help">
          Set <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> (see README), or run{' '}
          <code>mise run dev:local</code>, then restart the dev server.
        </p>
      </SignInFrame>
    )
  }
  if (userId === undefined) return null
  if (!userId) return <SignIn error={linkError} />
  if (owner !== userId) return null
  return <div key={userId}>{children}</div>
}
