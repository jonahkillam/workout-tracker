import { describe, expect, it } from 'vitest'
import { swipeDirection } from './useSwipe'

describe('swipeDirection', () => {
  it('reads a leftward swipe as next and a rightward one as previous', () => {
    expect(swipeDirection(-120, 10, 200)).toBe(1)
    expect(swipeDirection(120, -10, 200)).toBe(-1)
  })

  it('ignores short movements', () => {
    expect(swipeDirection(-40, 0, 100)).toBe(0)
  })

  it('ignores diagonal movements and vertical scrolls', () => {
    expect(swipeDirection(-100, 60, 200)).toBe(0)
    expect(swipeDirection(20, -300, 200)).toBe(0)
  })

  it('ignores slow drags', () => {
    expect(swipeDirection(-200, 0, 800)).toBe(0)
  })
})
