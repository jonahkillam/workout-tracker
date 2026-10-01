import type { Range, Step } from '../model/types'

/** Trims a number to at most `dp` decimals without trailing zeros. */
export function num(n: number, dp = 2): string {
  return String(Math.round(n * 10 ** dp) / 10 ** dp)
}

/**
 * The formatters below round for display. With `precise` they write exactly the value, for the
 * serializer: parsing the text gives the same number back.
 */
export function exact(n: number): string {
  const s = String(n)
  // The tokenizer reads plain decimals only, not `1e-7`.
  return s.includes('e') ? n.toFixed(20).replace(/\.?0+$/, '') : s
}

/** Rounds away float noise, as the parser does after converting units. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Shorthand duration: 40s, 10m, 1m30s, 1h5m. */
export function fmtDuration(secs: number, precise = false): string {
  if (precise && !Number.isInteger(secs)) return `${exact(secs)}s`
  const s = Math.round(secs)
  if (s < 120 && s % 60 !== 0) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  let out = ''
  if (h) out += `${h}h`
  if (m) out += `${m}m`
  if (r || !out) out += `${r}s`
  return out
}

/** Clock-style duration for display: 1:05:00, 42:10. */
export function fmtClock(secs: number): string {
  const s = Math.round(secs)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

/** Hours and minutes for totals: 5h20, 45m. */
export function fmtHours(secs: number): string {
  const mins = Math.round(secs / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`
}

export function fmtDistance(metres: number, precise = false): string {
  if (metres >= 1000 || metres % 1000 === 0) {
    const km = precise ? exact(metres / 1000) : num(metres / 1000, 3)
    // The parser reads km as round6(km × 1000); use metres when that wouldn't give the same value.
    if (!precise || round6(Number(km) * 1000) === metres) return `${km}km`
  }
  return `${precise ? exact(metres) : num(metres, 1)}mtr`
}

export function fmtPace(kmh: number): string {
  if (!(kmh > 0 && Number.isFinite(kmh))) return '–'
  const secs = Math.round(3600 / kmh)
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/**
 * A pace that parses back to `kmh`: m:ss when that's exact, otherwise decimal minutes (the grammar has no
 * fractional seconds), with as few decimals as give the same speed.
 */
function exactPace(kmh: number): string {
  const secs = Math.round(3600 / kmh)
  if (round6(3600 / secs) === round6(kmh)) return fmtPace(kmh)
  let mins = String(60 / kmh)
  for (let dp = 1; dp <= 15; dp++) {
    const m = (60 / kmh).toFixed(dp)
    if (round6(3600 / (Number(m) * 60)) === kmh) {
      mins = m.replace(/\.?0+$/, '')
      break
    }
  }
  return mins
}

export function fmtRange(r: Range, unit: string, prefix = '', precise = false): string {
  const f = precise ? exact : (n: number) => num(n)
  if (r.min === r.max) return `${prefix}${f(r.min)}${unit}`
  return `${prefix}${f(r.min)}-${prefix}${f(r.max)}${unit}`
}

export function fmtSpeed(r: Range, asPace?: boolean, precise = false): string {
  // A pace can't express a standstill, so write that as km/h.
  if (!asPace || (precise && !(r.min > 0))) return fmtRange(r, 'km/h', '', precise)
  const pace = precise ? exactPace : fmtPace
  // Faster speed is the lower pace, so max speed comes first.
  if (r.min === r.max) return `${pace(r.min)}/km`
  return `${pace(r.max)}-${pace(r.min)}/km`
}

export function mid(r: Range | undefined): number | undefined {
  return r === undefined ? undefined : (r.min + r.max) / 2
}

/** Reads a pace typed as "4:15", "4:15/km" or decimal minutes "4.25", returning km/h. */
export function parsePaceInput(text: string): number | undefined {
  const t = text.trim().replace(/\/km$/, '')
  if (!t) return undefined
  const clock = /^(\d+):(\d{1,2})$/.exec(t)
  const secs = clock ? Number(clock[1]) * 60 + Number(clock[2]) : Number(t) * 60
  return Number.isFinite(secs) && secs > 0 ? Math.round((3600 / secs) * 1e6) / 1e6 : undefined
}

/** A single speed shown in the preferred unit: "4:05/km" or "14.7 km/h". */
export function fmtSpeedIn(kmh: number, unit: 'kmh' | 'pace'): string {
  return unit === 'pace' ? `${fmtPace(kmh)}/km` : `${num(kmh, 1)} km/h`
}

/** A step's amount as written: 40s, 1km, 100fl. */
export function amountText(s: Step, precise = false): string {
  if (s.duration !== undefined) return fmtDuration(s.duration, precise)
  if (s.distance !== undefined) return fmtDistance(s.distance, precise)
  if (s.floors !== undefined) return `${precise ? exact(s.floors) : num(s.floors)}fl`
  return ''
}

