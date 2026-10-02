import { describe, expect, it } from 'vitest'
import { isDate } from '../metrics/dates'
import { linkUrl, parseLink } from './link'

describe('isDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isDate('2026-09-28')).toBe(true)
    expect(isDate('2024-02-29')).toBe(true)
    expect(isDate('2026-02-30')).toBe(false)
    expect(isDate('2026-13-01')).toBe(false)
    expect(isDate('2026-9-28')).toBe(false)
    expect(isDate('garbage')).toBe(false)
    expect(isDate('')).toBe(false)
  })
})

describe('parseLink', () => {
  it('reads a week from its Monday', () => {
    expect(parseLink('?week=2026-09-28')).toEqual({ week: '2026-09-28' })
  })

  it('reads a week from any date in it', () => {
    expect(parseLink('?week=2026-10-01')).toEqual({ week: '2026-09-28' })
    expect(parseLink('?week=2026-10-04')).toEqual({ week: '2026-09-28' })
  })

  it('ignores an invalid date', () => {
    expect(parseLink('?week=garbage')).toBeNull()
    expect(parseLink('?week=2026-02-30')).toBeNull()
    expect(parseLink('?week=')).toBeNull()
  })

  it('reads a workout id', () => {
    expect(parseLink('?workout=auto-strava-123')).toEqual({ workout: 'auto-strava-123' })
    expect(parseLink('?workout=a%2Fb%20c')).toEqual({ workout: 'a/b c' })
  })

  it('prefers the workout when both are given', () => {
    expect(parseLink('?week=2026-09-28&workout=abc')).toEqual({ workout: 'abc' })
  })

  it('finds nothing in other queries', () => {
    expect(parseLink('')).toBeNull()
    expect(parseLink('?code=123&state=xyz')).toBeNull()
    expect(parseLink('?workout=')).toBeNull()
  })
})

describe('linkUrl', () => {
  it('writes links at the root', () => {
    expect(linkUrl('https://log.example', { week: '2026-09-28' })).toBe('https://log.example/?week=2026-09-28')
  })

  it('round-trips through parseLink', () => {
    for (const link of [{ week: '2026-09-28' }, { workout: 'auto-strava-123' }, { workout: 'a/b c&d=e' }]) {
      expect(parseLink(new URL(linkUrl('https://log.example', link)).search)).toEqual(link)
    }
  })
})
