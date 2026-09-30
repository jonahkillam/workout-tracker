/**
 * SVG path through a bucketed series. Empty buckets are bridged unless they
 * span more than `maxGap` buckets, so sparse sampling draws a continuous line
 * while real gaps (pauses) break it.
 */
export function linePath(
  series: (number | undefined)[],
  x: (i: number) => number,
  y: (v: number) => number,
  maxGap: number,
): string {
  let d = ''
  let last = -Infinity
  series.forEach((v, i) => {
    if (v === undefined) return
    d += `${i - last > maxGap + 1 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    last = i
  })
  return d
}
