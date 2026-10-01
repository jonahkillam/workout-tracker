import type { Block, Range, Repeat, SpeedUnit, Step, StepKind, Targets } from '../model/types'
import { round, tokenize, type Token, type Unit } from './tokenizer'

export interface Diagnostic {
  start: number
  end: number
  severity: 'error' | 'warning'
  message: string
}

type TokenClass = 'head' | 'target' | 'role' | 'struct' | 'unknown'

export interface Highlight {
  start: number
  end: number
  cls: TokenClass
}

interface ParseResult {
  blocks: Block[]
  diagnostics: Diagnostic[]
  highlights: Highlight[]
}

type QToken = Extract<Token, { k: 'q' }>

export type TargetKey = Exclude<keyof Targets, 'asPace'>

/** Targets that apply to rest steps too when not split with `//`. */
export const APPLY_TO_ALL: readonly TargetKey[] = ['incline', 'level']

const TARGET_UNITS: Partial<Record<Unit, TargetKey>> = {
  '%': 'incline',
  kmh: 'speed',
  mph: 'speed',
  pkm: 'speed',
  pmi: 'speed',
  w: 'power',
  bpm: 'hr',
  zone: 'zone',
  rpe: 'rpe',
  spm: 'stepRate',
  lvl: 'level',
}

const HEAD_UNITS: Unit[] = ['s', 'min', 'h', 'km', 'mtr', 'mi', 'fl']

interface TargetValue {
  key: TargetKey
  range: Range
  asPace: boolean
}

interface TargetGroup {
  work?: TargetValue
  rest?: TargetValue
  split: boolean
}

const MILE = 1609.344

/** Converts a target quantity into the model's canonical unit. */
function targetValue(n: number, clock: boolean, unit: Unit): number {
  switch (unit) {
    case 'mph':
      return round(n * 1.609344)
    case 'pkm':
    case 'pmi': {
      const secs = clock ? n : n * 60
      const perKm = unit === 'pmi' ? secs / (MILE / 1000) : secs
      return round(3600 / perKm)
    }
    default:
      return n
  }
}

class Parser {
  private pos = 0
  readonly diagnostics: Diagnostic[] = []
  readonly highlights: Highlight[] = []
  private readonly tokens: Token[]
  private readonly src: string

  private readonly speedUnit: SpeedUnit
  /** Steps whose kind was written explicitly (`wu`, `rec`, `easy`, …) rather than defaulted. */
  private readonly explicitKind = new WeakSet<Step>()

  constructor(src: string, speedUnit: SpeedUnit) {
    this.src = src
    this.speedUnit = speedUnit
    this.tokens = tokenize(src)
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private next(cls?: TokenClass): Token {
    const t = this.tokens[this.pos++]
    if (cls) this.highlights.push({ start: t.start, end: t.end, cls })
    return t
  }

  private diag(t: { start: number; end: number }, message: string, severity: Diagnostic['severity'] = 'error') {
    this.diagnostics.push({ start: t.start, end: t.end, message, severity })
  }

  private isHead(t: Token | undefined): boolean {
    if (!t || t.k !== 'q') return false
    if (t.unit === null) return true
    return HEAD_UNITS.includes(t.unit)
  }

  /** Target list context: set after `@` or a first target, so bare numbers count as targets. */
  private inTargets = false

  private isTargetStart(t: Token | undefined): boolean {
    if (!t || t.k !== 'q') return false
    if (t.unit !== null) return TARGET_UNITS[t.unit] !== undefined
    return this.inTargets && this.peek(1)?.k !== 'x'
  }

  parseProgram(inParens: boolean): Block[] {
    const blocks: Block[] = []
    while (this.pos < this.tokens.length) {
      const t = this.peek()!
      if (t.k === 'sep') {
        this.next()
        continue
      }
      if (t.k === 'rp') {
        if (inParens) break
        this.diag(t, 'Unmatched ")"')
        this.next('unknown')
        continue
      }
      const before = this.pos
      const block = this.parseSegment()
      if (block) blocks.push(block)
      if (this.pos === before) {
        const bad = this.next('unknown')
        this.diag(bad, `Unexpected "${this.src.slice(bad.start, bad.end)}"`)
      }
    }
    return blocks
  }

  private parseRoles(): StepKind | undefined {
    let kind: StepKind | undefined
    while (this.peek()?.k === 'role') {
      kind = (this.next('role') as Extract<Token, { k: 'role' }>).kind
    }
    return kind
  }

  private parseSegment(): Block | null {
    const leadingRole = this.parseRoles()
    const t = this.peek()
    if (!t) return null

    if (t.k === 'q' && t.unit === null && this.peek(1)?.k === 'x') {
      return this.parseRepeat(leadingRole)
    }

    if (this.isHead(t)) {
      const q = this.next('head') as QToken
      const step: Step = { type: 'step', kind: leadingRole ?? 'steady', targets: {} }
      this.applyHeadQuantity(step, q, 'min')
      // A role word can come before or after the targets: `10m wu @ 6km/h`, `10m @ 6km/h wu`.
      const role = this.parseRoles()
      if (this.peek()?.k === 'rmark') {
        const r = this.next('struct')
        this.diag(r, 'Rest marker only applies to repeats', 'warning')
      }
      const targets = this.parseTargets()
      const kind = this.trailingRole ?? role ?? leadingRole
      if (kind) {
        step.kind = kind
        this.explicitKind.add(step)
      }
      this.applyTargets([step], targets, true)
      return step
    }

    if (t.k === 'at' || (t.k === 'q' && !this.isHead(t))) {
      const start = t
      this.parseTargets()
      this.diag(start, 'Targets without a preceding step are ignored', 'warning')
      return null
    }

    if (this.isSkipMarker()) {
      const dash = this.next('unknown')
      const r = this.next('unknown')
      this.diag({ start: dash.start, end: r.end }, '-r only applies to a repeat, e.g. 5x3m/2m -r')
      return null
    }
    if (t.k === 'unknown') {
      this.next('unknown')
      this.diag(t, 'Unrecognised text')
    }
    return null
  }

  /** Sets duration/distance/floors from a head quantity. */
  private applyHeadQuantity(step: Step, q: QToken, bareAs: 'min' | 's' | 'auto') {
    let unit = q.unit
    if (unit === null) {
      if (q.clock) unit = 's'
      else if (bareAs === 'auto') {
        unit = q.n >= 100 ? 'mtr' : 's'
        this.diag(q, `No unit — assumed ${unit === 'mtr' ? 'metres' : 'seconds'}`, 'warning')
      } else {
        unit = bareAs
        if (bareAs === 'min') this.diag(q, 'No unit — assumed minutes', 'warning')
      }
    }
    switch (unit) {
      case 's':
        step.duration = q.n
        break
      case 'min':
        step.duration = round(q.n * 60)
        break
      case 'h':
        step.duration = round(q.n * 3600)
        break
      case 'km':
        step.distance = round(q.n * 1000)
        break
      case 'mtr':
        step.distance = q.n
        break
      case 'mi':
        step.distance = round(q.n * MILE)
        break
      case 'fl':
        step.floors = q.n
        break
    }
  }

  private parseRepeat(leadingRole: StepKind | undefined): Repeat {
    const counts: number[] = []
    while (this.peek()?.k === 'q' && (this.peek() as QToken).unit === null && this.peek(1)?.k === 'x') {
      const q = this.next('struct') as QToken
      if (q.n === 0) this.diag(q, 'A repeat needs at least 1 repetition')
      else if (!Number.isInteger(q.n)) this.diag(q, 'Repeat count must be a whole number')
      counts.push(q.n)
      this.next('struct')
    }

    let body: Block[] = []
    const t = this.peek()
    if (t?.k === 'lp') {
      this.next('struct')
      body = this.parseProgram(true)
      this.inferKinds(body)
      if (this.peek()?.k === 'rp') this.next('struct')
      else this.diag(t, 'Missing ")"')
    } else if (this.isHead(t)) {
      const workQ = this.next('head') as QToken
      const work: Step = { type: 'step', kind: 'work', targets: {} }
      body.push(work)
      if (this.peek()?.k === 'slash' && this.isHead(this.peek(1))) {
        this.next('struct')
        this.applyHeadQuantity(work, workQ, 's')
        const rest: Step = { type: 'step', kind: 'rest', targets: {} }
        this.applyHeadQuantity(rest, this.next('head') as QToken, 's')
        body.push(rest)
      } else {
        this.applyHeadQuantity(work, workQ, 'auto')
      }
    } else if (t) {
      this.diag(t, 'Expected a duration, distance or "(" after the repeat count')
    }

    let role = this.parseRoles() ?? leadingRole

    let block: Repeat = { type: 'repeat', count: counts[counts.length - 1], children: body }
    for (let i = counts.length - 2; i >= 0; i--) {
      block = { type: 'repeat', count: counts[i], children: [block] }
    }

    // After the body, in any order: a set rest (`r3m`, no targets of its own),
    // `-r` to drop the final rest, and targets.
    let setRest: Step | undefined
    const groups: TargetGroup[] = []
    for (;;) {
      const before = this.pos
      if (!setRest) setRest = this.parseSetRest()
      if (this.parseSkipLastRest()) block.skipLastRest = true
      groups.push(...this.parseTargets())
      role = this.trailingRole ?? role
      if (this.pos === before) break
    }
    if (role && body[0]?.type === 'step' && body[0].kind === 'work' && role !== 'rest') body[0].kind = role
    this.applyTargets(leaves(block), groups, false)
    if (setRest) block.children.push(setRest)
    return block
  }

  /**
   * Inside a repeat, steps written without a role are work, except the last
   * step of the repeat, which is the rest: `10x(40s @ 8.5km/h, 20s @ 6.7km/h)`
   * reads like `10x40/20`. A repeat of a single step makes it work.
   */
  private inferKinds(body: Block[]) {
    const last = body.at(-1)
    for (const b of body) {
      if (b.type !== 'step' || this.explicitKind.has(b)) continue
      b.kind = b === last && body.length > 1 ? 'rest' : 'work'
    }
  }

  /** `-r`: leave out the repeat's final recovery. */
  private parseSkipLastRest(): boolean {
    if (!this.isSkipMarker()) return false
    this.next('struct')
    this.next('struct')
    return true
  }

  /** Whether the tokens at `offset` spell `-r` (and not the start of a rest like `-r3m`). */
  private isSkipMarker(offset = 0): boolean {
    const dash = this.peek(offset)
    const r = this.peek(offset + 1)
    if (dash?.k !== 'dash' || r?.k !== 'rmark' || r.end - r.start !== 1 || r.start !== dash.end) return false
    return !this.isHead(this.peek(offset + 2))
  }

  /** `r3m` or `w/ 90s`: rest after each set of the outermost repeat. */
  private parseSetRest(): Step | undefined {
    if (this.peek()?.k !== 'rmark') return undefined
    const marker = this.next('struct')
    if (!this.isHead(this.peek())) {
      this.diag(marker, 'Expected a rest duration after the rest marker')
      return undefined
    }
    const rest: Step = { type: 'step', kind: 'rest', targets: {} }
    this.applyHeadQuantity(rest, this.next('head') as QToken, 's')
    return rest
  }

  /** The last role word among the targets just parsed (`10m @ 8km/h wu`). */
  private trailingRole: StepKind | undefined

  /** Parses `@ target, target//target ...`. Stops at the next step head. */
  private parseTargets(): TargetGroup[] {
    const groups: TargetGroup[] = []
    this.inTargets = false
    this.trailingRole = undefined
    while (this.pos < this.tokens.length) {
      const t = this.peek()!
      if (t.k === 'at') {
        this.next('struct')
        this.inTargets = true
        continue
      }
      if (t.k === 'role') {
        // A role word right before a step head belongs to that step: `10m @ 6km/h wu 5m`.
        let i = 1
        while (this.peek(i)?.k === 'role') i++
        if (this.isHead(this.peek(i))) break
        this.trailingRole = this.parseRoles()
        continue
      }
      if (t.k === 'sep') {
        const after = this.peek(1)
        if (this.isTargetStart(after) || after?.k === 'at') {
          this.next()
          continue
        }
        // `…, 8km/h, -r`: the marker still belongs to the repeat before the comma.
        if (this.isSkipMarker(1)) this.next()
        break
      }
      if (this.isTargetStart(t) || t.k === 'dslash') {
        const g = this.parseTargetGroup()
        if (g) groups.push(g)
        this.inTargets = true
        continue
      }
      break
    }
    this.inTargets = false
    return groups
  }

  private parseTargetGroup(): TargetGroup | null {
    const left = this.peek()?.k === 'q' ? this.parseRangeTokens() : null
    let right: QToken[] | null = null
    let split = false
    if (this.peek()?.k === 'dslash') {
      this.next('struct')
      split = true
      right = this.peek()?.k === 'q' ? this.parseRangeTokens() : null
    }
    // Unit propagation: 8.3-8.8//6.5-7km/h, Z2-3.
    const unitOf = (qs: QToken[] | null) => qs?.find((q) => q.unit !== null)?.unit ?? null
    let unit = unitOf(left) ?? unitOf(right)
    const anchor = left?.[0] ?? right?.[0]
    if (!anchor) return null
    if (unit === null) {
      // Unitless targets are speeds in the workout's unit; mm:ss is always a pace.
      const clock = [...(left ?? []), ...(right ?? [])].some((q) => q.clock)
      unit = clock || this.speedUnit === 'pace' ? 'pkm' : 'kmh'
      // A plain number could have been meant as something else (incline, say), so say how it was read.
      if (!clock) this.diag(anchor, `No unit — read as ${unit === 'pkm' ? 'min/km' : 'km/h'}`, 'warning')
    }
    const key = TARGET_UNITS[unit]
    if (!key) {
      this.diag(anchor, 'Not a target')
      return null
    }
    const toValue = (qs: QToken[] | null): TargetValue | undefined => {
      if (!qs) return undefined
      const vals = qs.map((q) => {
        const u = q.unit ?? unit
        if (TARGET_UNITS[u] !== key) this.diag(q, 'Mixed units in target', 'warning')
        return targetValue(q.n, q.clock, u)
      })
      if (key === 'zone' && vals.some((v) => v < 1 || v > 5)) this.diag(qs[0], 'Zones go from Z1 to Z5', 'warning')
      return {
        key,
        range: { min: Math.min(...vals), max: Math.max(...vals) },
        asPace: unit === 'pkm' || unit === 'pmi',
      }
    }
    return { work: toValue(left), rest: toValue(right), split }
  }

  private parseRangeTokens(): QToken[] {
    const qs = [this.next('target') as QToken]
    if (this.peek()?.k === 'dash' && this.peek(1)?.k === 'q') {
      this.next('target')
      qs.push(this.next('target') as QToken)
    }
    return qs
  }

  private applyTargets(steps: Step[], groups: TargetGroup[], single: boolean) {
    for (const g of groups) {
      for (const step of steps) {
        const isRest = step.kind === 'rest'
        let v: TargetValue | undefined
        if (g.split) v = isRest ? g.rest : g.work
        else if (single || !isRest || APPLY_TO_ALL.includes(g.work!.key)) v = g.work
        if (!v) continue
        if (v.key === 'rpe') {
          step.targets.rpe ??= v.range.max
          continue
        }
        if (step.targets[v.key] !== undefined) continue
        step.targets[v.key] = v.range
        if (v.key === 'speed' && v.asPace) step.targets.asPace = true
      }
    }
  }
}

/** All leaf steps of a block, in order, without expanding repeat counts. */
function leaves(block: Block): Step[] {
  return block.type === 'step' ? [block] : block.children.flatMap(leaves)
}

interface ParseOptions {
  /** Unit for speeds written without one: `8.5` is km/h or 8.5 min/km. */
  speedUnit?: SpeedUnit
}

export function parseWorkout(src: string, options: ParseOptions = {}): ParseResult {
  const p = new Parser(src, options.speedUnit ?? 'kmh')
  const blocks = p.parseProgram(false)
  p.highlights.sort((a, b) => a.start - b.start)
  return { blocks, diagnostics: p.diagnostics, highlights: p.highlights }
}
