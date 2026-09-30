import { describe, expect, it } from 'vitest'
import { linePath } from './linePath'

const path = (series: (number | undefined)[], maxGap: number) => linePath(series, (i) => i, (v) => v, maxGap)

describe('linePath', () => {
  it('bridges short gaps', () => {
    expect(path([1, undefined, 3], 1)).toBe('M0.0,1.0L2.0,3.0')
  })

  it('breaks at long gaps', () => {
    expect(path([1, undefined, undefined, 4], 1)).toBe('M0.0,1.0M3.0,4.0')
  })

  it('starts with a move after leading gaps', () => {
    expect(path([undefined, 2, 3], 0)).toBe('M1.0,2.0L2.0,3.0')
  })
})
