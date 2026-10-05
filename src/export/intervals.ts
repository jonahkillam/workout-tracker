// A workout as an intervals.icu calendar event. The structure goes in `description` as intervals.icu's workout
// text: one `- <cue> <duration> <target>` line per step, and `Nx` blocks (set off by blank lines) for repeats.
import { num, fmtDuration, fmtPace } from '../parser/format'
import { mainSetSummary } from '../parser/summary'
import { stepZone } from '../metrics/workout'
import type { Block, Profile, Range, Sport, SpeedUnit, Step, Workout } from '../model/types'
import { SPORT_LABEL } from '../model/types'

export interface IntervalsEvent {
  category: 'WORKOUT'
  /** Local date at midnight, `YYYY-MM-DDT00:00:00`. */
  start_date_local: string
  type: string
  name: string
  description: string
  external_id: string
  indoor?: boolean
  /** Seconds, for workouts without steps. */
  moving_time?: number
}

/** Marks an event as ours, so only these are ever updated or deleted. */
const ID_PREFIX = 'workout-tracker:'

export function externalId(workoutId: string): string {
  return ID_PREFIX + workoutId
}

/** The workout id an event was made from, if this app made it. */
export function workoutIdOf(externalId: string | null | undefined): string | undefined {
  return externalId?.startsWith(ID_PREFIX) ? externalId.slice(ID_PREFIX.length) : undefined
}

// intervals.icu has no treadmill type; a virtual run is its indoor run.
const TYPE: Record<Sport, string> = { run: 'Run', treadmill: 'VirtualRun', stair: 'StairStepper', ride: 'Ride', other: 'Workout' }

const CUE: Partial<Record<Step['kind'], string>> = { wu: 'Warmup', cd: 'Cooldown', rest: 'Recovery' }

/** Steps to write in a row; `count` > 1 is a repeat block. */
interface Segment {
  count: number
  steps: Step[]
}

/**
 * The block tree as a flat list of segments, since intervals.icu has no nested repeats: the innermost repeats
 * stay repeats and the levels above them are written out. `-r` follows `expand`: a repeat that drops its final
 * recovery becomes one repetition fewer, then the last one written out without it.
 */
function segments(list: Block[], dropTail: boolean): Segment[] {
  const out: Segment[] = []
  list.forEach((b, i) => {
    const tail = dropTail && i === list.length - 1
    if (b.type === 'step') {
      if (!(tail && b.kind !== 'work')) out.push({ count: 1, steps: [b] })
      return
    }
    const drop = tail || !!b.skipLastRest
    const body = segments(b.children, false)
    const last = drop ? segments(b.children, true) : body
    if (body.every((s) => s.count === 1)) {
      const whole = drop ? b.count - 1 : b.count
      if (whole > 0) out.push({ count: whole, steps: body.flatMap((s) => s.steps) })
      if (drop && b.count > 0) out.push(...last)
    } else {
      for (let n = 0; n < b.count; n++) out.push(...(n === b.count - 1 ? last : body))
    }
  })
  return out
}

function range(r: Range, fmt: (n: number) => string = (n) => num(n)): string {
  return r.min === r.max ? fmt(r.min) : `${fmt(r.min)}-${fmt(r.max)}`
}

/** Words for a range inside a cue: no `%` or `-`, which intervals.icu could read as a target. */
function words(r: Range): string {
  return r.min === r.max ? num(r.min) : `${num(r.min)} to ${num(r.max)}`
}

function amount(s: Step): string | undefined {
  if (s.duration !== undefined) return fmtDuration(s.duration)
  if (s.distance === undefined) return undefined
  return s.distance >= 1000 && s.distance % 100 === 0 ? `${num(s.distance / 1000)}km` : `${num(s.distance)}mtr`
}

/** The one target intervals.icu can hold for a step: power, then pace, then zone, then heart rate. */
function target(s: Step, sport: Sport, profile: Profile | undefined): string | undefined {
  const t = s.targets
  if (t.power) return `${range(t.power)}w`
  // Fastest first, as intervals.icu writes pace ranges.
  if (t.speed && sport !== 'ride') {
    const paces = t.speed.min === t.speed.max ? [t.speed.max] : [t.speed.max, t.speed.min]
    return `${paces.map((v) => `${fmtPace(v)}/km`).join('-')} Pace`
  }
  if (t.zone) {
    const kind = sport === 'run' || sport === 'treadmill' ? ' Pace' : sport === 'ride' ? '' : ' HR'
    return `${range(t.zone, (z) => `Z${num(z)}`)}${kind}`
  }
  if (t.hr && profile?.lthr) {
    const lthr = profile.lthr
    return `${range({ min: Math.round((t.hr.min / lthr) * 100), max: Math.round((t.hr.max / lthr) * 100) })}% LTHR`
  }
  return undefined
}

/** What intervals.icu has no field for, as words in the step's cue. */
function cue(s: Step, sport: Sport, profile: Profile | undefined): string {
  const t = s.targets
  return [
    CUE[s.kind],
    t.incline && `incline ${words(t.incline)}`,
    t.level && `level ${words(t.level)}`,
    t.stepRate && `${words(t.stepRate)} spm`,
    t.speed && sport === 'ride' && `${words(t.speed)} kmh`,
    t.hr && !(profile?.lthr && !t.power && !t.speed && !t.zone) && `HR ${words(t.hr)}`,
    t.rpe !== undefined && `RPE ${num(t.rpe)}`,
    s.floors !== undefined && `${num(s.floors)} floors`,
  ]
    .filter(Boolean)
    .join(' ')
}

function stepLine(s: Step, sport: Sport, profile: Profile | undefined, rpe: number | undefined): string {
  // Without a duration or distance it can't be a step; it's left as a line of text.
  if (!amount(s)) return [cue(s, sport, profile), target(s, sport, profile)].filter(Boolean).join(' ')
  // intervals.icu draws nothing for a step without a target, so one without gets the zone this app gives it. As
  // a heart-rate zone off the bike: intervals.icu has an LTHR for nearly everyone, but often no threshold pace.
  const zone = stepZone(s, sport, profile ?? {}, rpe)
  const t = target(s, sport, profile) ?? `Z${zone}${sport === 'ride' ? '' : ' HR'}`
  return `- ${[cue(s, sport, profile), amount(s), t].filter(Boolean).join(' ')}`
}

/**
 * The steps as intervals.icu workout text. Pauses are left out: they aren't part of a plan. `rpe` is the
 * session RPE, which sets the zone of work steps without a target.
 */
export function intervalsText(blocks: Block[], sport: Sport, profile?: Profile, rpe?: number): string {
  const lines: string[] = []
  for (const seg of segments(blocks, false)) {
    const steps = seg.steps.filter((s) => s.kind !== 'pause')
    if (!steps.length) continue
    const body = steps.map((s) => stepLine(s, sport, profile, rpe))
    if (seg.count > 1) lines.push('', `${seg.count}x`, ...body, '')
    else lines.push(...body)
  }
  // One blank line around each repeat block, none at the ends.
  return lines.filter((l, i) => l || lines[i - 1]).join('\n').trim()
}

export function intervalsEvent(
  w: Pick<Workout, 'id' | 'date' | 'sport' | 'title' | 'blocks' | 'duration' | 'profile' | 'speedUnit' | 'rpe'>,
  speedUnit: SpeedUnit,
): IntervalsEvent {
  const description = intervalsText(w.blocks, w.sport, w.profile, w.rpe)
  return {
    category: 'WORKOUT',
    start_date_local: `${w.date}T00:00:00`,
    type: TYPE[w.sport],
    name: w.title || mainSetSummary(w.blocks, w.speedUnit ?? speedUnit) || SPORT_LABEL[w.sport],
    description,
    external_id: externalId(w.id),
    ...(w.sport === 'treadmill' ? { indoor: true } : {}),
    ...(!description && w.duration ? { moving_time: Math.round(w.duration) } : {}),
  }
}
