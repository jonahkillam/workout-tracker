import { useEffect } from 'react'
import { ensureStreams } from './streams'

/** Downloads the recordings' streams if this device doesn't have them yet. */
export function useEnsureStreams(ids: string[]) {
  const key = ids.join()
  useEffect(() => {
    if (key) void ensureStreams(key.split(','))
  }, [key])
}
