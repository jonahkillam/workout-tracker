import type { Session } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { userToOpen } from './user'

const session = { user: { id: 'user' } } as Session

describe('userToOpen', () => {
  it('opens for the session’s user', () => {
    expect(userToOpen(session, 'user', false)).toBe('user')
    expect(userToOpen(session, null, false)).toBe('user')
    expect(userToOpen(session, 'someone-else', false)).toBe('user')
  })

  it('opens for the local owner before the session has loaded', () => {
    expect(userToOpen(undefined, 'user', false)).toBe('user')
  })

  it('waits while nothing is known yet', () => {
    expect(userToOpen(undefined, undefined, false)).toBeUndefined()
    expect(userToOpen(undefined, null, false)).toBeUndefined()
    expect(userToOpen('offline', undefined, false)).toBeUndefined()
  })

  it('waits for the session on a sign-in link, which may be another user’s', () => {
    expect(userToOpen(undefined, 'user', true)).toBeUndefined()
    expect(userToOpen(session, 'someone-else', true)).toBe('user')
  })

  it('opens for the local owner when the session couldn’t be renewed offline', () => {
    expect(userToOpen('offline', 'user', false)).toBe('user')
    expect(userToOpen('offline', 'user', true)).toBe('user')
  })

  it('shows sign-in when signed out, or offline with no local data', () => {
    expect(userToOpen(null, 'user', false)).toBeNull()
    expect(userToOpen(null, null, false)).toBeNull()
    expect(userToOpen('offline', null, false)).toBeNull()
  })
})
