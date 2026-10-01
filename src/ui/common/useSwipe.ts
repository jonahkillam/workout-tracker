import { useEffect, useRef } from 'react'

const MIN_DISTANCE = 60
const MAX_MS = 600
/** Swipes from the screen edge belong to the browser's back/forward gesture. */
const EDGE = 24

/** 1 for a leftward swipe (next), -1 for a rightward one (previous), 0 if the movement isn't a sideways swipe. */
export function swipeDirection(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (ms >= MAX_MS || Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) <= 2 * Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

/** Calls `onSwipe` for one-finger sideways swipes anywhere on the page, unless they start in a field. */
export function useSwipe(onSwipe: (dir: -1 | 1) => void, enabled: boolean) {
  const handler = useRef(onSwipe)
  useEffect(() => {
    handler.current = onSwipe
  })

  useEffect(() => {
    if (!enabled) return
    let from: { x: number; y: number; at: number } | null = null
    const onStart = (e: TouchEvent) => {
      from = null
      if (e.touches.length !== 1) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const { clientX: x, clientY: y } = e.touches[0]
      if (x < EDGE || x > window.innerWidth - EDGE) return
      from = { x, y, at: e.timeStamp }
    }
    const onEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0]
      if (!from || !touch) return
      const dir = swipeDirection(touch.clientX - from.x, touch.clientY - from.y, e.timeStamp - from.at)
      from = null
      if (dir) handler.current(dir)
    }
    const onCancel = () => {
      from = null
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [enabled])
}
