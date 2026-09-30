// Works out a workout's structure (warm-up, reps, recoveries, cool-down) from a recording.
import { flatEquivalentRatio } from '../metrics/workout'
import type { Block, Lap, Profile, Range, Recording, RecordingStreams, Step, StepKind, Targets } from '../model/types'
import { stoppedAt } from './align'

/** Runs detect on speed, rides on power only. */
export function canDetect(rec: Recording, streams: RecordingStreams | undefined): boolean {
  if (!streams?.t.length) return false
  if (rec.sport === 'run') return !!(streams.speed || streams.distance)
  if (rec.sport === 'ride') return !!streams.power
  return false
}

/** Half-width of the smoothing window, seconds. */
const SMOOTH = 15
const MIN_WORK = 30
const MIN_GAP = 10
/** Average grades smaller than this, in percent, are left off as flat. */
const MIN_GRADE = 0.5
/** Stops at least this long become pause steps. */
const MIN_PAUSE = 60
/** In a recovery, standing still is part of the rest unless it lasts longer than this. */
const LONG_PAUSE = 300
/** Stream boundaries this close to a lap boundary move onto it. */
const SNAP = 15
/** Reps whose times differ by more than this go in separate groups. */
const GROUP_SPREAD = 10
/** Work starts at Z3: 88% of threshold pace (running), 75% of FTP (power). */
const RUN_WORK = 0.88
const RIDE_WORK = 0.75
/**
 * How much harder one stretch must be than another to count as a different
 * effort: for telling intervals apart without thresholds, confirming work
 * against its neighbours, and marking a warm-up or cool-down.
 */
const RUN_RATIO = 1.15
const RIDE_RATIO = 1.25

interface Segment {
  start: number
  end: number
  high: boolean
}

interface Stats {
  start: number
  end: number
  /** Seconds, not counting stops (for pace and averages; step durations use the clock). */
  moving: number
  distance: number
  /** Average pace as km/h for runs, power in watts for rides: what's written as the target. */
  value?: number
  /** Average of the detection metric (grade-adjusted m/s, or watts), for telling work from rest. */
  effort?: number
  /** Net climb over distance moved, percent; 0 when barely moving, undefined without altitude. */
  grade?: number
}

/** Distance at each sample, metres: the distance stream, or speed integrated over time. */
function distances(s: RecordingStreams): ArrayLike<number> {
  if (s.distance) return s.distance
  const out = new Float64Array(s.t.length)
  for (let i = 1; i < s.t.length; i++) out[i] = out[i - 1] + (s.speed?.[i - 1] ?? 0) * (s.t[i] - s.t[i - 1])
  return out
}

/** Grade at each sample over ±SMOOTH seconds (rise/run), or 0 without altitude or when barely moving. */
function grades(s: RecordingStreams, d: ArrayLike<number>): number[] {
  const { t, altitude } = s
  if (!altitude) return new Array<number>(t.length).fill(0)
  const out: number[] = []
  let lo = 0
  let hi = 0
  for (let i = 0; i < t.length; i++) {
    while (hi < t.length - 1 && t[hi + 1] <= t[i] + SMOOTH) hi++
    while (t[lo] < t[i] - SMOOTH) lo++
    const run = d[hi] - d[lo]
    out.push(run >= 20 ? (altitude[hi] - altitude[lo]) / run : 0)
  }
  return out
}

/**
 * Per-sample detection metric: grade-adjusted speed (Minetti 2002) in m/s for
 * runs, so climbing slowly doesn't read as recovery; power in watts for rides.
 * Zero while stopped.
 */
function metric(rec: Recording, s: RecordingStreams): number[] {
  const { t } = s
  const stopped = (i: number) => i > 0 && stoppedAt(s, rec.sport, i)
  if (rec.sport === 'ride') return Array.from(s.power!, (p, i) => (stopped(i) ? 0 : p))
  const d = distances(s)
  const grade = grades(s, d)
  return Array.from({ length: t.length }, (_, i) => {
    if (stopped(i)) return 0
    const speed = s.speed ? s.speed[i] : i && t[i] > t[i - 1] ? (d[i] - d[i - 1]) / (t[i] - t[i - 1]) : 0
    return speed * flatEquivalentRatio(grade[i])
  })
}

/** Whether the recording was moving at each sample (the first counts as moving). */
function movingMask(rec: Recording, s: RecordingStreams): boolean[] {
  return Array.from(s.t, (_, i) => i === 0 || !stoppedAt(s, rec.sport, i))
}

/**
 * Centred rolling mean over ±SMOOTH seconds of moving samples, so stops don't
 * drag the edges of what's around them down. Zero while stopped.
 */
function smooth(t: Uint32Array, v: number[], moving: boolean[]): number[] {
  const out: number[] = []
  let lo = 0
  let hi = 0
  let sum = 0
  let n = 0
  for (let i = 0; i < t.length; i++) {
    for (; hi < t.length && t[hi] <= t[i] + SMOOTH; hi++) {
      if (moving[hi]) {
        sum += v[hi]
        n++
      }
    }
    for (; t[lo] < t[i] - SMOOTH; lo++) {
      if (moving[lo]) {
        sum -= v[lo]
        n--
      }
    }
    out.push(moving[i] && n ? sum / n : 0)
  }
  return out
}

/** Stretches the recording was stopped for at least MIN_PAUSE seconds, on its clock. */
function stops(moving: boolean[], t: Uint32Array): [number, number][] {
  const out: [number, number][] = []
  for (let i = 1; i < t.length; i++) {
    if (moving[i]) continue
    let j = i
    while (j + 1 < t.length && !moving[j + 1]) j++
    if (t[j] - t[i - 1] >= MIN_PAUSE) out.push([t[i - 1], t[j]])
    i = j
  }
  return out
}

/** Split point of a 1-D two-cluster split (maximising between-group variance), with the two means. */
export function twoMeans(values: number[], weights?: number[]): { split: number; lo: number; hi: number } | undefined {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const w = (i: number) => weights?.[i] ?? 1
  let total = 0
  let totalW = 0
  for (const i of idx) {
    total += values[i] * w(i)
    totalW += w(i)
  }
  let best: { split: number; lo: number; hi: number; score: number } | undefined
  let sum = 0
  let sumW = 0
  for (let k = 0; k < idx.length - 1; k++) {
    sum += values[idx[k]] * w(idx[k])
    sumW += w(idx[k])
    if (values[idx[k]] === values[idx[k + 1]]) continue
    const lo = sum / sumW
    const hi = (total - sum) / (totalW - sumW)
    const score = sumW * (totalW - sumW) * (hi - lo) ** 2
    if (!best || score > best.score) best = { split: (values[idx[k]] + values[idx[k + 1]]) / 2, lo, hi, score }
  }
  return best
}

/**
 * The value above which effort counts as work: from the athlete's threshold if
 * known, otherwise the two-cluster split when the data is clearly two-level.
 */
function workThreshold(rec: Recording, profile: Profile, values: number[], weights?: number[]): number | undefined {
  if (rec.sport === 'run' && profile.thresholdSpeed) return (profile.thresholdSpeed / 3.6) * RUN_WORK
  if (rec.sport === 'ride' && profile.ftp) return profile.ftp * RIDE_WORK
  // Standing still or coasting would otherwise look like a second level (floor: 1 m/s, or 1 W).
  const keep = values.map((_, i) => i).filter((i) => values[i] >= 1)
  const m = twoMeans(keep.map((i) => values[i]), weights && keep.map((i) => weights[i]))
  if (!m || m.lo <= 0) return undefined
  return m.hi / m.lo >= (rec.sport === 'run' ? RUN_RATIO : RIDE_RATIO) ? m.split : undefined
}

function mergeSame(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    if (s.end <= s.start) continue
    const last = out[out.length - 1]
    if (last && last.high === s.high) last.end = s.end
    else out.push({ ...s })
  }
  return out
}

/** Flips too-short segments: brief dips inside work, and work too short to be a rep. */
function cleanUp(segs: Segment[]): Segment[] {
  let out = mergeSame(segs.map((s, i) => (!s.high && i > 0 && i < segs.length - 1 && s.end - s.start < MIN_GAP ? { ...s, high: true } : s)))
  out = mergeSame(out.map((s) => (s.high && s.end - s.start < MIN_WORK ? { ...s, high: false } : s)))
  return out
}

/** Auto-laps: every lap but the last has the same distance, or the same duration. */
export function isAutoLaps(laps: Lap[]): boolean {
  if (laps.length < 2) return true
  const body = laps.slice(0, -1)
  const same = (get: (l: Lap) => number | undefined, tol: (x: number) => number) => {
    const first = get(body[0])
    return first !== undefined && first > 0 && body.every((l) => Math.abs((get(l) ?? -1) - first) <= tol(first))
  }
  return same((l) => l.distance, (x) => x * 0.02) || same((l) => l.duration, () => 2)
}

/** Mean of `v` over samples with `from <= t < to`. */
function meanBetween(t: Uint32Array, v: number[], from: number, to: number): number | undefined {
  let sum = 0
  let n = 0
  for (let i = 0; i < t.length && t[i] < to; i++) {
    if (t[i] >= from) {
      sum += v[i]
      n++
    }
  }
  return n ? sum / n : undefined
}

/**
 * Smoothing blurs where effort changes, so move each boundary to the sharpest
 * rise (into work) or drop (out of it) in the raw data within SMOOTH seconds.
 */
function refine(t: Uint32Array, v: number[], segs: Segment[]): Segment[] {
  const out = segs.map((s) => ({ ...s }))
  for (let i = 1; i < out.length; i++) {
    const b = out[i].start
    const sign = out[i].high ? 1 : -1
    let best = b
    let bestJump = -Infinity
    for (let j = 0; j < t.length && t[j] <= b + SMOOTH; j++) {
      const c = t[j]
      if (c < b - SMOOTH || c <= out[i - 1].start || c >= out[i].end) continue
      const before = meanBetween(t, v, c - 10, c)
      const after = meanBetween(t, v, c, c + 10)
      if (before === undefined || after === undefined) continue
      const jump = sign * (after - before)
      if (jump > bestJump) {
        bestJump = jump
        best = c
      }
    }
    out[i - 1].end = best
    out[i].start = best
  }
  return out
}

/** Moves each boundary between segments onto a mark (lap or stop edge) within SNAP seconds. */
function snapTo(segs: Segment[], marks: number[]): Segment[] {
  if (!marks.length) return segs
  const out = segs.map((s) => ({ ...s }))
  for (let i = 1; i < out.length; i++) {
    const b = out[i].start
    const near = marks.reduce((a, m) => (Math.abs(m - b) < Math.abs(a - b) ? m : a))
    if (Math.abs(near - b) <= SNAP && near > out[i - 1].start && near < out[i].end) {
      out[i - 1].end = near
      out[i].start = near
    }
  }
  return mergeSame(out)
}

function statsFor(rec: Recording, s: RecordingStreams, m: number[], start: number, end: number): Stats {
  const { t } = s
  let moving = 0
  let distance = 0
  let power = 0
  let effort = 0
  let rise = 0
  for (let i = 1; i < t.length; i++) {
    if (t[i] > end) break
    if (t[i - 1] < start || stoppedAt(s, rec.sport, i)) continue
    const dt = t[i] - t[i - 1]
    moving += dt
    if (s.distance) distance += s.distance[i] - s.distance[i - 1]
    else if (s.speed) distance += s.speed[i - 1] * dt
    if (s.power) power += s.power[i] * dt
    effort += m[i] * dt
    if (s.altitude) rise += s.altitude[i] - s.altitude[i - 1]
  }
  const grade = s.altitude ? (distance >= 50 ? (rise / distance) * 100 : 0) : undefined
  if (!moving) return { start, end, moving, distance, grade }
  const value = rec.sport === 'ride' ? power / moving : distance > 0 ? (distance / moving) * 3.6 : undefined
  return { start, end, moving, distance, value, effort: effort / moving, grade }
}

/** Segments from deliberate (non-auto) laps, classed as high or low. */
function lapSegments(rec: Recording, s: RecordingStreams, m: number[], profile: Profile): Segment[] {
  const laps = rec.laps.map((l) => statsFor(rec, s, m, l.start, l.start + l.duration))
  const values = laps.map((l) => l.effort ?? 0)
  const threshold = workThreshold(rec, profile, values, laps.map((l) => l.moving))
  return mergeSame(laps.map((l, i) => ({ start: l.start, end: l.end, high: threshold !== undefined && values[i] > threshold })))
}

/** Segments found in the stream, snapped onto nearby laps. */
function streamSegments(rec: Recording, s: RecordingStreams, raw: number[], moving: boolean[], profile: Profile): Segment[] {
  const { t } = s
  const v = smooth(t, raw, moving)
  const end = t[t.length - 1]
  const threshold = workThreshold(rec, profile, v)
  if (threshold === undefined) return [{ start: t[0], end, high: false }]
  const segs: Segment[] = []
  for (let i = 0; i < t.length; i++) {
    const high = v[i] > threshold
    const last = segs[segs.length - 1]
    if (last && last.high === high) continue
    if (last) last.end = t[i]
    segs.push({ start: t[i], end, high })
  }
  return snapTo(refine(t, raw, cleanUp(segs)), rec.laps.map((l) => l.start).filter((x) => x > 0))
}

const round5 = (x: number) => Math.round(x / 5) * 5

/** Usual rep distances, metres. */
const REP_DISTANCES = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 1600, 2000, 3000, 4000, 5000]

/** The usual rep distance within 2% of `d`, if any. */
function nominalDistance(d: number): number | undefined {
  return REP_DISTANCES.find((n) => Math.abs(d - n) / n <= 0.02)
}

/** Speeds are snapped to whole-second paces so equal paces read as equal. */
function snapPace(kmh: number): number {
  return 3600 / Math.round(3600 / kmh)
}

function targetOf(rec: Recording, values: (number | undefined)[]): Targets {
  const known = values.filter((x): x is number => x !== undefined)
  if (!known.length) return {}
  if (rec.sport === 'ride') {
    const w = known.map(Math.round)
    return { power: { min: Math.min(...w), max: Math.max(...w) } }
  }
  const k = known.map(snapPace)
  const range: Range = { min: Math.min(...k), max: Math.max(...k) }
  return { speed: range, asPace: true }
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** Average grade as an incline target, if any grade is known. */
function inclineOf(grades: (number | undefined)[]): Targets {
  const known = grades.filter((g): g is number => g !== undefined)
  if (!known.length) return {}
  const g = round1(known.reduce((a, b) => a + b, 0) / known.length)
  return { incline: { min: g, max: g } }
}

const sloped = (t: Targets) => !!t.incline && Math.abs(t.incline.min) >= MIN_GRADE

function wholeStep(rec: Recording, kind: StepKind, s: Stats): Step {
  const incline = inclineOf([s.grade])
  return {
    type: 'step',
    kind,
    duration: Math.round(s.end - s.start),
    targets: { ...(sloped(incline) ? incline : {}), ...targetOf(rec, [s.value]) },
  }
}

interface Rep {
  work: Stats
  rest?: Stats
}

const span = (s: Stats) => s.end - s.start
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)

function fits(rec: Recording, group: Rep[], rep: Rep): boolean {
  const nominal = (s: Stats) => (rec.sport === 'run' ? nominalDistance(s.distance) : undefined)
  if (nominal(group[0].work) !== nominal(rep.work)) return false
  if (spread([...group, rep].map((r) => span(r.work))) > GROUP_SPREAD) return false
  const rests = [...group, rep].flatMap((r) => (r.rest ? [span(r.rest)] : []))
  return rests.length < 2 || spread(rests) <= GROUP_SPREAD
}

function groupBlocks(rec: Recording, group: Rep[]): Block[] {
  const nominal = rec.sport === 'run' ? nominalDistance(group[0].work.distance) : undefined
  const meanSpan = (xs: Stats[]) => xs.reduce((a, s) => a + span(s), 0) / xs.length
  const rests = group.flatMap((r) => (r.rest ? [r.rest] : []))
  // Average grade for the reps and the recoveries. Written for both or neither, so the pair keeps its compact form.
  const workIncline = inclineOf(group.map((r) => r.work.grade))
  const restIncline = inclineOf(rests.map((r) => r.grade))
  const hilly = sloped(workIncline) || sloped(restIncline)
  const work: Step = {
    type: 'step',
    kind: 'work',
    ...(nominal !== undefined ? { distance: nominal } : { duration: Math.max(5, round5(meanSpan(group.map((r) => r.work)))) }),
    targets: { ...(hilly ? workIncline : {}), ...targetOf(rec, group.map((r) => r.work.value)) },
  }
  const rest: Step | undefined = rests.length
    ? { type: 'step', kind: 'rest', duration: Math.max(5, round5(meanSpan(rests))), targets: hilly ? restIncline : {} }
    : undefined
  if (group.length === 1) return rest ? [work, rest] : [work]
  return [
    {
      type: 'repeat',
      count: group.length,
      children: rest ? [work, rest] : [work],
      ...(rest && !group[group.length - 1].rest ? { skipLastRest: true } : {}),
    },
  ]
}

const ratioFor = (rec: Recording) => (rec.sport === 'run' ? RUN_RATIO : RIDE_RATIO)

/** Whether effort `hard` is clearly above `easy`. Stretches with no moving time count as no effort. */
function clearlyAbove(rec: Recording, hard: number | undefined, easy: number | undefined): boolean {
  return (hard ?? 0) > 0 && (easy ?? 0) * ratioFor(rec) <= (hard ?? 0)
}

/**
 * Keeps only clear work: a high segment must be clearly harder than the
 * segments either side of it. A high segment with nothing to compare against
 * (the whole activity) is steady, not work.
 */
function clearWork(rec: Recording, segs: Segment[], effort: (g: Segment) => number | undefined): Segment[] {
  for (;;) {
    const efforts = segs.map(effort)
    let changed = false
    const next = segs.map((g, i) => {
      if (!g.high) return g
      const neighbours = [i - 1, i + 1].filter((j) => j >= 0 && j < segs.length)
      const clear = neighbours.length > 0 && neighbours.every((j) => clearlyAbove(rec, efforts[i], efforts[j]))
      if (clear) return g
      changed = true
      return { ...g, high: false }
    })
    if (!changed) return segs
    segs = mergeSame(next)
  }
}

interface Piece {
  kind: StepKind
  start: number
  end: number
}

/**
 * Cuts long stops out of the labelled segments as pauses. Standing still in a
 * recovery stays part of it unless it's longer than LONG_PAUSE.
 */
function withPauses(pieces: Piece[], stopped: [number, number][]): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    let at = p.start
    for (const [a, z] of stopped) {
      const from = Math.max(a, p.start)
      const to = Math.min(z, p.end)
      if (to - from < MIN_PAUSE || (p.kind === 'rest' && to - from <= LONG_PAUSE)) continue
      if (from > at) out.push({ kind: p.kind, start: at, end: from })
      out.push({ kind: 'pause', start: from, end: to })
      at = to
    }
    if (p.end > at) out.push({ kind: p.kind, start: at, end: p.end })
  }
  // A pause straddling a boundary leaves two halves; join them.
  return out.reduce<Piece[]>((acc, p) => {
    const last = acc[acc.length - 1]
    if (last?.kind === 'pause' && p.kind === 'pause' && last.end === p.start) last.end = p.end
    else acc.push(p)
    return acc
  }, [])
}

/** Whether a rep's recovery is a real one: mostly moving, and clearly easier than the rep. */
function activeRecovery(rec: Recording, rep: Rep): boolean {
  return !!rep.rest && rep.rest.moving >= span(rep.rest) / 2 && clearlyAbove(rec, rep.work.effort, rep.rest.effort)
}

/** Reps that group under `fits` from the first one on: same distance or duration, and even recoveries. */
function regular(rec: Recording, reps: Rep[]): boolean {
  return reps.every((rep, i) => i === 0 || fits(rec, reps.slice(0, i), rep))
}

/** Moving-time-weighted mean effort over some stretches, or undefined if none of them moved. */
function meanEffort(stats: Stats[]): number | undefined {
  const moving = stats.reduce((a, s) => a + s.moving, 0)
  return moving ? stats.reduce((a, s) => a + (s.effort ?? 0) * s.moving, 0) / moving : undefined
}

/**
 * Whether labelled pieces clearly look like a workout rather than an ordinary
 * run or ride with some variation in it:
 * - Reps separated only by standing still (lights, a gate, a photo) are one
 *   broken effort, unless they're regular, as reps with standing recoveries are.
 * - That leaves at least two efforts, so a single surge or fast finish doesn't count.
 * - The work is clearly harder than the rest of the moving time.
 */
function looksLikeWorkout(rec: Recording, pieces: Piece[], statsOf: (p: Piece) => Stats): boolean {
  const reps: Rep[] = []
  pieces.forEach((p, k) => {
    if (p.kind !== 'work') return
    const next = pieces[k + 1]
    reps.push({ work: statsOf(p), rest: next?.kind === 'rest' ? statsOf(next) : undefined })
  })
  let efforts = 0
  let chain: Rep[] = []
  const endChain = () => {
    if (chain.length) efforts += chain.length > 1 && regular(rec, chain) ? chain.length : 1
    chain = []
  }
  for (const rep of reps) {
    chain.push(rep)
    if (activeRecovery(rec, rep)) endChain()
  }
  endChain()
  if (efforts < 2) return false
  const easy = meanEffort(pieces.filter((p) => p.kind !== 'work' && p.kind !== 'pause').map(statsOf))
  return easy === undefined || clearlyAbove(rec, meanEffort(reps.map((r) => r.work)), easy)
}

/** Detected blocks, and whether they have workout structure (reps) or are a single unstructured effort. */
export interface Detected {
  blocks: Block[]
  structured: boolean
}

/**
 * The recording's structure as blocks, or undefined if it can't be worked out
 * (wrong sport, or no speed/power data). Steps follow the recording's clock, so
 * the plan lines up with it at offset 0. Stops of a minute or more are `pause`
 * steps, which keep that alignment without counting as training. Unless it
 * clearly looks like a workout (see `looksLikeWorkout`), it's steady stretches
 * between pauses, marked unstructured.
 */
export function detectBlocks(rec: Recording, streams: RecordingStreams | undefined, profile: Profile): Detected | undefined {
  if (!canDetect(rec, streams)) return undefined
  const s = streams!
  const m = metric(rec, s)
  const moving = movingMask(rec, s)
  const stopped = stops(moving, s.t)
  // Effort changes next to a stop happen at the stop, so no slivers are left around pauses.
  const found = snapTo(
    rec.laps.length >= 3 && !isAutoLaps(rec.laps) ? lapSegments(rec, s, m, profile) : streamSegments(rec, s, m, moving, profile),
    stopped.flat(),
  )
  const statsOf = (p: { start: number; end: number }) => statsFor(rec, s, m, p.start, p.end)
  const effortOf = (a: number, z: number) => statsFor(rec, s, m, a, z).effort
  const segs = clearWork(rec, found, (g) => effortOf(g.start, g.end))
  const first = segs.findIndex((g) => g.high)
  const last = segs.findLastIndex((g) => g.high)
  // Low stretches outside the reps are steady for now; only the ends can become a warm-up or cool-down.
  const labelled: Piece[] = segs.map((g, i) => ({
    start: g.start,
    end: g.end,
    kind: g.high ? 'work' : first !== -1 && i > first && i < last ? 'rest' : 'steady',
  }))
  const steady = () => withPauses([{ kind: 'steady', start: labelled[0].start, end: labelled[labelled.length - 1].end }], stopped)
  let pieces = first === -1 ? steady() : withPauses(labelled, stopped)
  const structured = first !== -1 && looksLikeWorkout(rec, pieces, statsOf)
  if (!structured) pieces = steady()
  else {
    // The first stretch is a warm-up, and the last a cool-down, only if clearly easier than the one beside it.
    const active = pieces.filter((p) => p.kind !== 'pause')
    const [head, afterHead] = active
    const [tail, beforeTail] = [active[active.length - 1], active[active.length - 2]]
    if (head.kind === 'steady' && afterHead && clearlyAbove(rec, effortOf(afterHead.start, afterHead.end), effortOf(head.start, head.end))) {
      head.kind = 'wu'
    }
    if (tail.kind === 'steady' && beforeTail && clearlyAbove(rec, effortOf(beforeTail.start, beforeTail.end), effortOf(tail.start, tail.end))) {
      tail.kind = 'cd'
    }
  }

  const blocks: Block[] = []
  let group: Rep[] = []
  const flush = () => {
    if (group.length) blocks.push(...groupBlocks(rec, group))
    group = []
  }
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]
    const stats = statsOf(p)
    if (p.kind === 'pause') {
      flush()
      blocks.push({ type: 'step', kind: 'pause', duration: Math.round(p.end - p.start), targets: {} })
    } else if (p.kind === 'work') {
      const next = pieces[k + 1]
      const rep: Rep = { work: stats, rest: next?.kind === 'rest' ? statsOf(next) : undefined }
      if (rep.rest) k++
      if (group.length && group[group.length - 1].rest && fits(rec, group, rep)) group.push(rep)
      else {
        flush()
        group = [rep]
      }
    } else {
      flush()
      blocks.push(wholeStep(rec, p.kind, stats))
    }
  }
  flush()
  return { blocks, structured }
}
