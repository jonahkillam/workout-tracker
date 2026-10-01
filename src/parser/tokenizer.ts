import type { StepKind } from '../model/types'

/**
 * Quantity units after normalisation. `null` means a bare number.
 * Clock values (mm:ss, h:mm:ss) are stored as seconds with `clock: true`.
 */
export type Unit =
  | 's'
  | 'min'
  | 'h'
  | 'km'
  | 'mtr'
  | 'mi'
  | 'fl'
  | 'kmh'
  | 'mph'
  | 'pkm'
  | 'pmi'
  | '%'
  | 'w'
  | 'bpm'
  | 'spm'
  | 'zone'
  | 'rpe'
  | 'lvl'

export type Token =
  | { k: 'q'; n: number; clock: boolean; unit: Unit | null; start: number; end: number }
  | { k: 'role'; kind: StepKind; start: number; end: number }
  | {
      k: 'x' | 'dash' | 'slash' | 'dslash' | 'at' | 'sep' | 'lp' | 'rp' | 'rmark' | 'unknown'
      start: number
      end: number
    }

const UNIT_ALIASES: Record<string, Unit> = {
  s: 's',
  sec: 's',
  secs: 's',
  m: 'min',
  min: 'min',
  mins: 'min',
  h: 'h',
  hr: 'h',
  km: 'km',
  mtr: 'mtr',
  mi: 'mi',
  fl: 'fl',
  floors: 'fl',
  'km/h': 'kmh',
  kph: 'kmh',
  kmh: 'kmh',
  mph: 'mph',
  '/km': 'pkm',
  '/mi': 'pmi',
  '%': '%',
  w: 'w',
  bpm: 'bpm',
  spm: 'spm',
}

// Longest alternatives first so `km/h` wins over `km`, `mins` over `m`, etc.
// `w` followed by a single `/` is the rest marker (`6x800 w/ 90s`), not watts.
const UNIT_RE =
  /\s*(km\/h|\/km|\/mi|kph|kmh|mph|mins|min|mtr|secs|sec|floors|fl|km|mi|hr|bpm|spm|h|m|s|w(?!\/(?!\/))|%)(?![a-zA-Z])/iy

const NEGATIVE_GRADE_RE = /[-–](\d+(?:\.\d+)?|\.\d+)\s*%/y

/** The negative low end of a grade range: `-3` in `-3--1%` or `-2-1%`. */
const NEGATIVE_RANGE_START_RE = /[-–](\d+(?:\.\d+)?|\.\d+)(?=[-–][-–]?(?:\d+(?:\.\d+)?|\.\d+)\s*%)/y

/** A further part of a compound duration: `5m` and `30s` in `1h5m30s`, or `30m` in `1h 30m`. */
const DURATION_PART_RE = /(\s*)(\d+(?:\.\d+)?)(h|m|s)(?![a-zA-Z])/y

const SECONDS = { h: 3600, m: 60, s: 1 }

const SINGLE: Record<string, Token['k']> = {
  '/': 'slash',
  '@': 'at',
  '(': 'lp',
  ')': 'rp',
  '-': 'dash',
  '–': 'dash',
  '×': 'x',
}

const NUMBER_RE = /(\d+:\d{2}(?::\d{2})?)|(\d+(?:\.\d+)?|\.\d+)/y

const PREFIXED_RE = /(z|zone|rpe|lvl|level|l)\s*(\d+(?:\.\d+)?)(?![a-zA-Z\d])/iy

const WORD_RE = /[a-zA-Z]+(?:-[a-zA-Z]+)?/y

const ROLE_WORDS: Record<string, StepKind> = {
  wu: 'wu',
  warmup: 'wu',
  'warm-up': 'wu',
  warm: 'wu',
  cd: 'cd',
  cooldown: 'cd',
  'cool-down': 'cd',
  cool: 'cd',
  work: 'work',
  on: 'work',
  hard: 'work',
  tempo: 'work',
  int: 'work',
  interval: 'work',
  intervals: 'work',
  rest: 'rest',
  rec: 'rest',
  recovery: 'rest',
  off: 'rest',
  walk: 'rest',
  easy: 'steady',
  steady: 'steady',
  jog: 'steady',
  aerobic: 'steady',
  endurance: 'steady',
  pause: 'pause',
  paused: 'pause',
  stop: 'pause',
  stopped: 'pause',
}

function parseClock(s: string): number {
  const parts = s.split(':').map(Number)
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Rounds away float noise from unit conversions (`1.1m` is 66s, not 66.00000000000001s). */
export function round(n: number, dp = 6): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

function matchAt(re: RegExp, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(src)
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let pos = 0

  while (pos < src.length) {
    const ch = src[pos]

    if (ch === '\n' || ch === ',' || ch === ';' || ch === '+') {
      tokens.push({ k: 'sep', start: pos, end: pos + 1 })
      pos++
      continue
    }
    if (/\s/.test(ch)) {
      pos++
      continue
    }
    if (src.startsWith('//', pos)) {
      tokens.push({ k: 'dslash', start: pos, end: pos + 2 })
      pos += 2
      continue
    }
    if (src.startsWith('w/', pos) || src.startsWith('W/', pos)) {
      tokens.push({ k: 'rmark', start: pos, end: pos + 2 })
      pos += 2
      continue
    }
    // A negative grade (`-3%`, `2%//-1%`, `5:00/km -2%`, `-3--1%`). Right after a number, `-` is a range
    // dash instead (`5-6km/h`, `2-4%`).
    const prev = tokens[tokens.length - 1]
    const negative =
      (ch === '-' || ch === '–') &&
      (prev?.k !== 'q' || prev.end < pos) &&
      (matchAt(NEGATIVE_GRADE_RE, src, pos) ?? matchAt(NEGATIVE_RANGE_START_RE, src, pos))
    if (negative) {
      tokens.push({ k: 'q', n: -Number(negative[1]), clock: false, unit: '%', start: pos, end: pos + negative[0].length })
      pos += negative[0].length
      continue
    }
    if (ch in SINGLE) {
      tokens.push({ k: SINGLE[ch], start: pos, end: pos + 1 } as Token)
      pos++
      continue
    }

    const num = matchAt(NUMBER_RE, src, pos)
    if (num) {
      const start = pos
      const clock = num[1] !== undefined
      let n = clock ? parseClock(num[1]) : Number(num[2])
      pos += num[0].length
      let unit: Unit | null = null
      const u = matchAt(UNIT_RE, src, pos)
      if (u && !clock) {
        unit = UNIT_ALIASES[u[1].toLowerCase()]
        pos += u[0].length
        // Compound durations: 1h5m, 5m30s. A space is allowed only after hours (`1h 30m`), since `1m 30s`
        // also reads as two steps.
        if (unit === 'h' || unit === 'min') {
          let last = unit === 'h' ? SECONDS.h : SECONDS.m
          n *= last
          for (let next; (next = matchAt(DURATION_PART_RE, src, pos)); ) {
            const secs = SECONDS[next[3] as 'h' | 'm' | 's']
            if (next[1] && (last !== SECONDS.h || secs === SECONDS.h)) break
            n += Number(next[2]) * secs
            last = secs
            pos += next[0].length
          }
          n = round(n)
          unit = 's'
        }
      } else if (u && clock && ['pkm', 'pmi'].includes(UNIT_ALIASES[u[1].toLowerCase()])) {
        unit = UNIT_ALIASES[u[1].toLowerCase()]
        pos += u[0].length
      }
      tokens.push({ k: 'q', n, clock, unit, start, end: pos })
      continue
    }

    const prefixed = matchAt(PREFIXED_RE, src, pos)
    if (prefixed) {
      const p = prefixed[1].toLowerCase()
      const unit: Unit = p === 'z' || p === 'zone' ? 'zone' : p === 'rpe' ? 'rpe' : 'lvl'
      tokens.push({ k: 'q', n: Number(prefixed[2]), clock: false, unit, start: pos, end: pos + prefixed[0].length })
      pos += prefixed[0].length
      continue
    }

    const word = matchAt(WORD_RE, src, pos)
    if (word) {
      const w = word[0].toLowerCase()
      const end = pos + word[0].length
      if (w === 'x') tokens.push({ k: 'x', start: pos, end })
      else if (w === 'r') tokens.push({ k: 'rmark', start: pos, end })
      else if (w in ROLE_WORDS) tokens.push({ k: 'role', kind: ROLE_WORDS[w], start: pos, end })
      else tokens.push({ k: 'unknown', start: pos, end })
      pos = end
      continue
    }

    tokens.push({ k: 'unknown', start: pos, end: pos + 1 })
    pos++
  }
  return tokens
}
