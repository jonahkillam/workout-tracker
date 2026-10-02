// Links to a week or a workout: `/?week=2026-09-28`, `/?workout=<id>`.
// A link is a one-shot instruction. It is read on load and removed from the address bar, so the URL stays `/`
// and a bookmark always opens the current week.
import { isDate, weekStart } from '../metrics/dates'

export type Link = { week: string } | { workout: string }

/** The link in a query string, if any. A week is given by any date in it; a workout wins over a week. */
export function parseLink(search: string): Link | null {
  const params = new URLSearchParams(search)
  const workout = params.get('workout')
  if (workout) return { workout }
  const week = params.get('week')
  return week && isDate(week) ? { week: weekStart(week) } : null
}

export function linkUrl(origin: string, link: Link): string {
  return `${origin}/?${new URLSearchParams(link)}`
}

let pending: Link | null = null

/**
 * Take the link out of the address bar and hold it until the app is on screen, which may be after sign-in.
 * Other query params (e.g. an auth `code`) are left for their own handlers.
 */
export function captureLink(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('week') && !url.searchParams.has('workout')) return
  pending = parseLink(url.search)
  url.searchParams.delete('week')
  url.searchParams.delete('workout')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

export function pendingLink(): Link | null {
  return pending
}

export function clearLink(): void {
  pending = null
}
