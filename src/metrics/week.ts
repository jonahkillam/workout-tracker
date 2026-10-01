import type { Profile, Recording, Sport, Workout } from '../model/types'
import { addDays, weekDays } from './dates'
import { recordedTotals, sessionTotals } from './recorded'
import { addTotals, emptyTotals, type Totals } from './workout'

export interface WeekSummary {
  start: string
  total: Totals
  bySport: Partial<Record<Sport, Totals & { count: number }>>
  /** Load per day, Monday first. */
  dailyLoad: number[]
}

/** Recordings that no workout links to: unstructured activities, counted as sessions of their own. */
function unlinkedRecordings(workouts: Workout[], recordings: Recording[]): Recording[] {
  const linked = new Set(workouts.map((w) => w.recording?.id).filter(Boolean))
  return recordings.filter((r) => !linked.has(r.id))
}

/**
 * Totals for the week. Workouts count from their recording where it measures
 * them properly (see `sessionTotals`); unlinked recordings count as recorded.
 */
function summarizeWeek(
  start: string,
  workouts: Workout[],
  fallback: Profile,
  recordings: Recording[] = [],
  unlinked = unlinkedRecordings(workouts, recordings),
): WeekSummary {
  const days = weekDays(start)
  const summary: WeekSummary = { start, total: emptyTotals(), bySport: {}, dailyLoad: days.map(() => 0) }
  const add = (date: string, sport: Sport, t: Totals) => {
    const dayIndex = days.indexOf(date)
    if (dayIndex === -1) return
    summary.total = addTotals(summary.total, t)
    const prev = summary.bySport[sport]
    summary.bySport[sport] = { ...addTotals(prev ?? emptyTotals(), t), count: (prev?.count ?? 0) + 1 }
    summary.dailyLoad[dayIndex] += t.load
  }
  const byId = new Map(recordings.map((r) => [r.id, r]))
  for (const w of workouts) add(w.date, w.sport, sessionTotals(w, w.recording && byId.get(w.recording.id), fallback))
  for (const r of unlinked) add(r.localDate, r.sport, recordedTotals(r, r.sport, r.profile ?? fallback))
  return summary
}

/** Summaries for `count` consecutive weeks ending with the week starting `lastStart`. */
export function summarizeWeeks(
  lastStart: string,
  count: number,
  workouts: Workout[],
  fallback: Profile,
  recordings: Recording[] = [],
): WeekSummary[] {
  // Linked across all weeks, in case a workout and its recording fall either side of a week boundary.
  const unlinked = unlinkedRecordings(workouts, recordings)
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(lastStart, -7 * (count - 1 - i))
    const end = addDays(start, 6)
    return summarizeWeek(
      start,
      workouts.filter((w) => w.date >= start && w.date <= end),
      fallback,
      recordings,
      unlinked.filter((r) => r.localDate >= start && r.localDate <= end),
    )
  })
}

/** Acute:chronic workload ratio: this week's load vs the mean of the previous four. */
export function acuteChronicRatio(weeks: WeekSummary[]): number | undefined {
  if (weeks.length < 5) return undefined
  const acute = weeks[weeks.length - 1].total.load
  const chronic = weeks.slice(-5, -1).reduce((s, w) => s + w.total.load, 0) / 4
  return chronic > 0 ? acute / chronic : undefined
}
