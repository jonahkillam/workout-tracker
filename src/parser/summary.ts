import { stepDuration } from '../metrics/workout'
import type { Block, SpeedUnit, Step } from '../model/types'
import { amountText, fmtHours, fmtRange, fmtSpeed, num } from './format'

/** Short amount: 40s, 5m, 0:02:30, 1h30, 800mtr, 5km, 100fl. */
function amount(s: Step): string {
  if (s.duration === undefined) return amountText(s)
  const d = Math.round(s.duration)
  if (d < 120 && d % 60 !== 0) return `${d}s`
  if (d < 3600 && d % 60 === 0) return `${d / 60}m`
  if (d < 3600) return `0:${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`
  // 1h30, and 2h rather than 2h00.
  return fmtHours(d).replace(/h00$/, 'h')
}

/** Work/rest pair, sharing the unit when both are seconds: 40/20s, 5m/2m, 1km/90s. */
function pair(work: Step, rest: Step): string {
  const w = amount(work)
  const r = amount(rest)
  return w.endsWith('s') && r.endsWith('s') ? `${w.slice(0, -1)}/${r}` : `${w}/${r}`
}

/** The single most telling target of a step. */
function keyTarget(s: Step, speedUnit: SpeedUnit): string {
  const t = s.targets
  if (t.incline && t.incline.max > 0) return fmtRange(t.incline, '%')
  // Shown in the current unit, however it was typed.
  if (t.speed && speedUnit === 'pace') return fmtSpeed(t.speed, true)
  if (t.speed) return `${num(t.speed.min, 1)}${t.speed.max !== t.speed.min ? `-${num(t.speed.max, 1)}` : ''}km/h`
  if (t.power) return fmtRange(t.power, 'W')
  if (t.zone) return fmtRange(t.zone, '', 'Z')
  if (t.rpe !== undefined) return `RPE ${num(t.rpe, 1)}`
  if (t.level) return fmtRange(t.level, '', 'L')
  if (t.stepRate) return fmtRange(t.stepRate, 'spm')
  return ''
}

const isRest = (b: Block | undefined): b is Step => b?.type === 'step' && b.kind === 'rest'

/**
 * Drops a set recovery: a trailing rest or easy step after a nested repeat (`3x(10x40/20, 5m easy)`).
 * A trailing rest after plain steps is part of the body: `4x(1m, 2m, 3m)` is three steps.
 */
function withoutSetRest(children: Block[]): Block[] {
  const last = children.at(-1)
  if (children.length < 2 || last?.type !== 'step') return children
  const afterRepeat = children.at(-2)?.type === 'repeat' && (last.kind === 'rest' || last.kind === 'steady')
  return afterRepeat ? children.slice(0, -1) : children
}

/** Compact repeat: counts × work(/rest), ignoring set rests. */
function repeatSummary(r: Extract<Block, { type: 'repeat' }>, speedUnit: SpeedUnit): string {
  const counts = [r.count]
  let body = withoutSetRest(r.children)
  while (body.length === 1 && body[0].type === 'repeat') {
    counts.push(body[0].count)
    body = withoutSetRest(body[0].children)
  }
  const steps = body.filter((b): b is Step => b.type === 'step')
  const work = steps.find((s) => s.kind !== 'rest') ?? steps[0]
  let shape = `(${body.length} steps)`
  if (steps.length === body.length && steps.length === 1) shape = amount(steps[0])
  else if (steps.length === body.length && steps.length === 2 && steps[0] === work && isRest(steps[1])) {
    shape = pair(work, steps[1])
  }
  const target = work ? keyTarget(work, speedUnit) : ''
  return `${counts.join('×')}×${shape}${target ? ` @ ${target}` : ''}`
}

/**
 * A glanceable one-liner for a workout: its repeat blocks, or its main step
 * when there are none. Warm-ups, cool-downs, set rests and secondary targets
 * are left out.
 */
export function mainSetSummary(blocks: Block[], speedUnit: SpeedUnit): string {
  const main = blocks.filter((b) => b.type === 'repeat' || (b.kind !== 'wu' && b.kind !== 'cd' && b.kind !== 'pause'))
  const repeats = main.filter((b) => b.type === 'repeat')
  if (repeats.length) return repeats.map((r) => repeatSummary(r, speedUnit)).join(' + ')
  const steps = main as Step[]
  if (!steps.length) return ''
  // By time where known (distance at a target speed counts too), otherwise by distance.
  const longest = steps.reduce((a, b) => {
    const [ta, tb] = [stepDuration(a), stepDuration(b)]
    if (ta !== undefined || tb !== undefined) return (tb ?? 0) > (ta ?? 0) ? b : a
    return (b.distance ?? b.floors ?? 0) > (a.distance ?? a.floors ?? 0) ? b : a
  })
  const target = keyTarget(longest, speedUnit)
  return `${amount(longest)}${target ? ` @ ${target}` : ''}`
}
