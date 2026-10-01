import type { Block, Range, Repeat, Step, StepKind, Targets } from '../model/types'
import { amountText, exact, fmtDuration, fmtRange, fmtSpeed, num } from './format'
import { APPLY_TO_ALL, type TargetKey } from './parser'

export const TARGET_ORDER: TargetKey[] = ['incline', 'speed', 'power', 'hr', 'zone', 'rpe', 'stepRate', 'level']

const ROLE_WORD: Record<StepKind, string> = {
  wu: 'wu',
  cd: 'cd',
  work: 'work',
  rest: 'rec',
  steady: '',
  pause: 'pause',
}

/** One target in shorthand, rounded for display unless `precise` (as the serializer writes it). */
export function fmtTarget(key: TargetKey, t: Targets, precise = false): string | undefined {
  if (key === 'rpe') return t.rpe === undefined ? undefined : `rpe${precise ? exact(t.rpe) : num(t.rpe, 1)}`
  const r = t[key]
  if (!r) return undefined
  switch (key) {
    case 'incline':
      return fmtRange(r, '%', '', precise)
    case 'speed':
      return fmtSpeed(r, t.asPace, precise)
    case 'power':
      return fmtRange(r, 'w', '', precise)
    case 'hr':
      return fmtRange(r, 'bpm', '', precise)
    case 'zone':
      return fmtRange(r, '', 'Z', precise)
    case 'stepRate':
      return fmtRange(r, 'spm', '', precise)
    case 'level':
      return fmtRange(r, '', 'lvl', precise)
  }
}

/** A step's targets in shorthand, for display: `15%, 8.5km/h, Z4`. */
export function fmtTargets(t: Targets, keys: TargetKey[] = TARGET_ORDER, precise = false): string {
  return keys.map((k) => fmtTarget(k, t, precise)).filter(Boolean).join(', ')
}

function sameValue(a: Range | number | undefined, b: Range | number | undefined): boolean {
  if (typeof a === 'object' && typeof b === 'object') return a.min === b.min && a.max === b.max
  return a === b
}

function singleTargets(t: Targets): string {
  const text = fmtTargets(t, TARGET_ORDER, true)
  return text && ` @ ${text}`
}

/**
 * Targets for a work/rest pair written once, e.g. `@ 15%, 8.5km/h//6.5km/h`.
 * Returns null when the pair's targets can't be expressed that way.
 */
function pairTargets(work: Targets, rest: Targets): string | null {
  if (work.speed && rest.speed && !!work.asPace !== !!rest.asPace) return null
  const parts: string[] = []
  for (const key of TARGET_ORDER) {
    const w = fmtTarget(key, work, true)
    const r = fmtTarget(key, rest, true)
    if (!w && !r) continue
    if (APPLY_TO_ALL.includes(key)) {
      if (!w || !r) return null
      parts.push(sameValue(work[key], rest[key]) ? w : `${w}//${r}`)
    } else {
      if (!w) return null
      parts.push(r ? `${w}//${r}` : w)
    }
  }
  return parts.length ? ` @ ${parts.join(', ')}` : ''
}

/**
 * A step's amount, written exactly. A step without one (possible only from the step table) has no
 * shorthand: it serializes to its targets alone, which parse to nothing, so the table must not allow it.
 */
function head(step: Step, bare = false): string {
  return bare && step.duration !== undefined && step.duration < 100 ? exact(step.duration) : amountText(step, true)
}

/**
 * Inside a repeat an unmarked step is read as work or rest, so a steady step
 * there needs its role written out.
 */
function serializeStep(step: Step, inRepeat: boolean): string {
  const role = inRepeat && step.kind === 'steady' ? 'easy' : ROLE_WORD[step.kind]
  return [head(step), role].filter(Boolean).join(' ') + singleTargets(step.targets)
}

function isStep(b: Block | undefined, kind?: StepKind): b is Step {
  return b?.type === 'step' && (kind === undefined || b.kind === kind)
}

function hasHead(s: Step): boolean {
  return s.duration !== undefined || s.distance !== undefined || s.floors !== undefined
}

function isSetRest(b: Block | undefined): b is Step {
  return isStep(b, 'rest') && b.duration !== undefined && Object.keys(b.targets).length === 0
}

/**
 * Compact form of a repeat body: `10x40/20 @ ...`, `6x1km @ ...`, or nested `3x10x...`.
 * Returns null when the body needs the explicit `(…)` form.
 */
function compactBody(children: Block[]): { counts: number[]; text: string } | null {
  if (children.length === 2 && isStep(children[0], 'work') && isStep(children[1], 'rest')) {
    const [w, r] = children
    if (w.duration === undefined && w.distance === undefined) return null
    if (r.duration === undefined && r.distance === undefined) return null
    const targets = pairTargets(w.targets, r.targets)
    if (targets === null) return null
    // Short pairs are written as bare seconds (40/20), unless whole minutes read better (1m/1m).
    const bare =
      w.duration !== undefined &&
      r.duration !== undefined &&
      w.duration < 100 &&
      r.duration < 100 &&
      !(w.duration % 60 === 0 && r.duration % 60 === 0)
    return { counts: [], text: `${head(w, bare)}/${head(r, bare)}${targets}` }
  }
  if (children.length === 1 && isStep(children[0], 'work') && hasHead(children[0])) {
    const w = children[0]
    // A bare-looking single body would be read as metres/seconds, so always use units.
    return { counts: [], text: head(w) + singleTargets(w.targets) }
  }
  if (children.length === 1 && children[0].type === 'repeat' && !children[0].skipLastRest) {
    const inner = compactBody(children[0].children)
    if (inner) return { counts: [children[0].count, ...inner.counts], text: inner.text }
  }
  return null
}

/** Inserts suffix markers (set rest, `-r`) before the targets of a compact repeat. */
function withSuffix(text: string, suffix: string): string {
  const at = text.indexOf(' @ ')
  return at === -1 ? text + suffix : text.slice(0, at) + suffix + text.slice(at)
}

function serializeRepeat(r: Repeat): string {
  const skip = r.skipLastRest ? ' -r' : ''
  const direct = compactBody(r.children)
  if (direct) return withSuffix(`${[r.count, ...direct.counts].join('x')}x${direct.text}`, skip)

  let children = r.children
  let setRest = ''
  const last = children[children.length - 1]
  if (children.length >= 2 && isSetRest(last)) {
    children = children.slice(0, -1)
    setRest = ` r${fmtDuration(last.duration!, true)}`
  }
  const compact = compactBody(children)
  if (compact) return withSuffix(`${[r.count, ...compact.counts].join('x')}x${compact.text}`, setRest + skip)
  return `${r.count}x(${serializeList(children, true)})${setRest}${skip}`
}

function serializeList(blocks: Block[], inRepeat: boolean): string {
  return blocks.map((b) => (b.type === 'step' ? serializeStep(b, inRepeat) : serializeRepeat(b))).join(', ')
}

export function serializeBlocks(blocks: Block[]): string {
  return serializeList(blocks, false)
}
