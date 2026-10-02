import type { Session } from '@supabase/supabase-js'

/**
 * What is known of the sign-in: the session, `null` when signed out, `undefined` while the client is still
 * loading it, and `'offline'` when the stored session's access token has expired and there was no connection to
 * renew it (the client then reports no session, though nobody signed out).
 */
export type SessionState = Session | 'offline' | null | undefined

/**
 * The user to open the app for; `null` shows sign-in and `undefined` waits. `localOwner` is the user the local
 * database belongs to (`null` if nobody, `undefined` while loading).
 *
 * Without a session to go by, the app opens for the local owner: their data is already on the device, so it
 * needs no connection, and sync picks up once the session can be renewed. A sign-in link is the exception,
 * since it may sign in someone else; then the session is waited for.
 */
export function userToOpen(
  session: SessionState,
  localOwner: string | null | undefined,
  signInLink: boolean,
): string | null | undefined {
  if (session === null) return null
  if (session === 'offline') return localOwner
  if (session) return session.user.id
  return signInLink ? undefined : (localOwner ?? undefined)
}
