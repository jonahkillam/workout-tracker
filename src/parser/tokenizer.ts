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
const UNIT_RE =
  /\s*(km\/h|\/km|\/mi|kph|kmh|mph|mins|min|mtr|secs|sec|floors|fl|km|mi|hr|bpm|spm|h|m|s|w|%)(?![a-zA-Z])/iy

const NEGATIVE_GRADE_RE = /[-–](\d+(?:\.\d+)?|\.\d+)\s*%/y

const NUMBER_RE = /(\d+:\d{2}(?::\d{2})?)|(\d+(?:\.\d+)?|\.\d+)/y

const PREFIXED_RE = /(z|zone|rpe|lvl|level|l)\s*(\d+(?:\.\d+)?)(?![a-zA-Z\d])/iy

const WORD_RE = /[a-zA-Z]+(?:-[a-zA-Z]+)?/y

export const ROLE_WORDS: Record<string, StepKind> = {
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
    // A negative grade (`-3%`, `2%//-1%`). After a number, `-` is a range dash instead.
    const negative = (ch === '-' || ch === '–') && tokens[tokens.length - 1]?.k !== 'q' && matchAt(NEGATIVE_GRADE_RE, src, pos)
    if (negative) {
      tokens.push({ k: 'q', n: -Number(negative[1]), clock: false, unit: '%', start: pos, end: pos + negative[0].length })
      pos += negative[0].length
      continue
    }
    const single: Record<string, Token['k']> = {
      '/': 'slash',
      '@': 'at',
      '(': 'lp',
      ')': 'rp',
      '-': 'dash',
      '–': 'dash',
      '×': 'x',
    }
    if (ch in single) {
      tokens.push({ k: single[ch], start: pos, end: pos + 1 } as Token)
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
        // Compound durations: 1h5m, 5m30s.
        if (unit === 'h' || unit === 'min') {
          n = n * (unit === 'h' ? 3600 : 60)
          let more = true
          while (more) {
            more = false
            const next = matchAt(/(\d+(?:\.\d+)?)(h|m|s)(?![a-zA-Z])/y, src, pos)
            if (next) {
              n += Number(next[1]) * { h: 3600, m: 60, s: 1 }[next[2] as 'h' | 'm' | 's']
              pos += next[0].length
              more = true
            }
          }
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
