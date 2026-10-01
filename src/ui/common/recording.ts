import type { Recording } from '../../model/types'

/** The activity's page on Strava, if it came from there. */
export function stravaUrl(r: Recording): string | undefined {
  return r.stravaId ? `https://www.strava.com/activities/${r.stravaId}` : undefined
}

/** Local start time, e.g. `07:05`. */
export function fmtStart(r: Recording): string {
  return new Date(r.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
