import type { Profile, Sport, Workout } from '../model/types'
import { addDays, weekDays } from './dates'
import { addTotals, emptyTotals, workoutTotals, type Totals } from './workout'

export interface WeekSummary {
  start: string
  total: Totals
  bySport: Partial<Record<Sport, Totals & { count: number }>>
  /** Load per day, Monday first. */
  dailyLoad: number[]
}

export function summarizeWeek(start: string, workouts: Workout[], fallback: Profile): WeekSummary {
  const days = weekDays(start)
  const summary: WeekSummary = { start, total: emptyTotals(), bySport: {}, dailyLoad: days.map(() => 0) }
  for (const w of workouts) {
    const dayIndex = days.indexOf(w.date)
    if (dayIndex === -1) continue
    const t = workoutTotals(w, fallback)
    summary.total = addTotals(summary.total, t)
    const prev = summary.bySport[w.sport]
    summary.bySport[w.sport] = { ...addTotals(prev ?? emptyTotals(), t), count: (prev?.count ?? 0) + 1 }
    summary.dailyLoad[dayIndex] += t.load
  }
  return summary
}

/** Summaries for `count` consecutive weeks ending with the week starting `lastStart`. */
export function summarizeWeeks(lastStart: string, count: number, workouts: Workout[], fallback: Profile): WeekSummary[] {
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(lastStart, -7 * (count - 1 - i))
    const end = addDays(start, 6)
    return summarizeWeek(
      start,
      workouts.filter((w) => w.date >= start && w.date <= end),
      fallback,
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
