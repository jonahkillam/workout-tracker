import { useCallback, useEffect, useRef, useState } from 'react'
import { syncWeek, type SyncResult } from './sync'

interface Outcome {
  week: string
  result?: SyncResult
  error?: string
}

/** Syncs the displayed week from Strava when it changes; `refresh` forces a refetch. */
export function useWeekSync(weekStart: string, connected: boolean) {
  const [outcome, setOutcome] = useState<Outcome>()
  const [forcing, setForcing] = useState(false)
  // Ignore results for a week that's no longer on screen.
  const latest = useRef(0)

  const run = useCallback(
    (force: boolean) => {
      const request = ++latest.current
      return syncWeek(weekStart, { force })
        .then((result) => ({ week: weekStart, result }))
        .catch((e: Error) => ({ week: weekStart, error: e.message }))
        .then((o) => {
          if (request === latest.current) setOutcome(o)
        })
    },
    [weekStart],
  )

  useEffect(() => {
    if (connected) void run(false)
  }, [connected, run])

  const current = outcome?.week === weekStart ? outcome : undefined
  return {
    syncing: connected && (!current || forcing),
    result: current?.result,
    error: current?.error,
    refresh: () => {
      setForcing(true)
      void run(true).finally(() => setForcing(false))
    },
  }
}
