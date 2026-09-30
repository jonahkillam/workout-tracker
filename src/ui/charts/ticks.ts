const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
const VALUE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100]

/** Multiples of `step` within `[from, to]`. */
function multiples(from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let v = Math.ceil(from / step) * step; v <= to; v += step) out.push(v)
  return out
}

/** Round-number times (seconds) across `[from, to]`, at most about `count` of them. */
export function timeTicks(from: number, to: number, count = 6): number[] {
  const step = TIME_STEPS.find((s) => (to - from) / s <= count) ?? Math.ceil((to - from) / count / 3600) * 3600
  return multiples(from, to, step)
}

/** Round-number values across `[min, max]`, at most about `count` of them. */
export function valueTicks(min: number, max: number, count = 4, steps = VALUE_STEPS): number[] {
  const last = steps[steps.length - 1]
  const step = steps.find((s) => (max - min) / s <= count) ?? Math.ceil((max - min) / count / last) * last
  return multiples(min, max, step)
}

/** Whole-minute paces, seconds per km, fastest first. */
const ROUND_PACES = [120, 180, 240, 300, 360, 420, 480, 600, 720, 900, 1200]

/**
 * Round paces (seconds per km) to label a zero-based speed axis that runs from 0
 * to `maxKmh` over `pixels`. Paces bunch up towards the top, so fastest-first,
 * each label is kept only if it's at least `minGap` pixels from the last.
 */
export function paceTicks(maxKmh: number, pixels: number, minGap = 16): number[] {
  const out: number[] = []
  let lastY = -Infinity
  for (const pace of ROUND_PACES) {
    const kmh = 3600 / pace
    if (kmh > maxKmh) continue
    const y = (1 - kmh / maxKmh) * pixels
    if (y - lastY < minGap) continue
    out.push(pace)
    lastY = y
  }
  return out
}
