import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'
import { loadStravaConnection } from '../strava/auth'
import { adoptOwner, startSync } from '../sync/engine'
import { supabase, supabaseConfigured } from '../supabase'
import { finishMagicLink } from './session'
import { SignIn, SignInFrame } from './SignIn'

/**
 * Shows sign-in until there's a session, then the app for that user. The session is kept in localStorage, so
 * the app opens offline once signed in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // undefined while loading.
  const [session, setSession] = useState<Session | null>()
  const [linkError, setLinkError] = useState<string>()
  // The user whose data the local database now holds.
  const [owner, setOwner] = useState<string>()
  const userId = session?.user.id

  useEffect(() => {
    if (!supabaseConfigured) return
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    void finishMagicLink().then(async (error) => {
      setLinkError(error)
      setSession((await supabase.auth.getSession()).data.session)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!userId) return
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
  if (session === undefined) return null
  if (!session) return <SignIn error={linkError} />
  if (owner !== userId) return null
  return <div key={userId}>{children}</div>
}
