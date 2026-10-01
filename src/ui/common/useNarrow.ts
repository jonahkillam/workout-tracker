import { useSyncExternalStore } from 'react'

/** The same breakpoint as the `max-width: 700px` rules in index.css. */
const QUERY = '(max-width: 700px)'

const subscribe = (onChange: () => void) => {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** True at phone width, where the editor swaps inline fields for sheets. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches)
}
