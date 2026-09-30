// Calendar helpers on ISO dates (YYYY-MM-DD), in local time.

function parse(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function toISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function today(): string {
  return toISO(new Date())
}

export function addDays(iso: string, days: number): string {
  const d = parse(iso)
  d.setDate(d.getDate() + days)
  return toISO(d)
}

/** Monday of the week containing `iso`. */
export function weekStart(iso: string): string {
  const d = parse(iso)
  const offset = (d.getDay() + 6) % 7
  return addDays(iso, -offset)
}

export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

export function fmtDay(iso: string): { weekday: string; day: string } {
  const d = parse(iso)
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    day: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
  }
}

export function fmtWeekRange(start: string): string {
  const end = parse(addDays(start, 6))
  const s = parse(start)
  const sameMonth = s.getMonth() === end.getMonth()
  const left = s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const right = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })
  return `${left} – ${right} ${end.getFullYear()}`
}

/** ISO 8601 week number. */
export function isoWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  // The Thursday of this week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  return Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7)
}

export function fmtLongDate(iso: string): string {
  return parse(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}
