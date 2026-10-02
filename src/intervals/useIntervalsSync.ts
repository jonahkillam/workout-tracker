import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { today } from '../metrics/dates'
import { syncIntervals } from './sync'

/** Long enough that a burst of saves (or a pull from the server) goes out as one run. */
const DEBOUNCE = 1500

/**
 * Sends planned workouts to intervals.icu when they change, when the app opens and when it comes back online,
 * on devices that have an API key. `ready` is the first pull having finished. Returns the last error, if any.
 */
export function useIntervalsSync(ready: boolean): string | undefined {
  const [error, setError] = useState<string>()
  // Changes whenever something the calendar shows could have: the workouts from today on, and the connection.
  const signature = useLiveQuery(async () => {
    if (!(await db.intervalsConnection.get('intervals'))) return null
    const ahead = await db.workouts.where('date').aboveOrEqual(today()).toArray()
    return JSON.stringify(ahead.map((w) => [w.id, w.updatedAt, !!w.recording]).sort())
  }, [])

  useEffect(() => {
    if (!ready || signature == null) return
    const run = () =>
      syncIntervals().then(
        () => setError(undefined),
        (e: Error) => setError(e.message),
      )
    const timer = setTimeout(run, DEBOUNCE)
    window.addEventListener('online', run)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', run)
    }
  }, [ready, signature])

  return signature == null ? undefined : error
}
