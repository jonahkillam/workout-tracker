// Keeps the intervals.icu calendar in step with the planned workouts. Each run compares what intervals.icu has
// with the local workouts and sends the difference, so nothing is queued and a run can be repeated safely.
import { db, loadSettings } from '../db/db'
import { intervalsEvent, workoutIdOf, type IntervalsEvent } from '../export/intervals'
import { addDays, today } from '../metrics/dates'
import { isPlanned, type SpeedUnit, type Workout } from '../model/types'
import { intervalsApi, type IntervalsApi, type RemoteEvent } from './api'

/** How far ahead events are looked for. */
const HORIZON_DAYS = 730

export interface Changes {
  create: IntervalsEvent[]
  update: { id: number; event: IntervalsEvent }[]
  remove: number[]
}

const COMPARED = ['start_date_local', 'type', 'name', 'description', 'moving_time'] as const

function same(remote: RemoteEvent, event: IntervalsEvent): boolean {
  return COMPARED.every((k) => String(remote[k] ?? '').trim() === String(event[k] ?? '').trim())
}

/**
 * What to send so the calendar matches the plan. `workouts` are the planned ones from `from` on, plus the
 * workout behind every event in `remote` that still exists.
 * - A planned workout from `from` on with no event gets one.
 * - An event whose workout is still planned follows it (also to an earlier date).
 * - An event whose workout now has a recording is left: intervals.icu pairs it with the activity.
 * - An event whose workout is gone is deleted. Events this app didn't create are never touched.
 */
export function changes(workouts: Workout[], remote: RemoteEvent[], from: string, speedUnit: SpeedUnit): Changes {
  const byId = new Map(workouts.map((w) => [w.id, w]))
  const out: Changes = { create: [], update: [], remove: [] }
  const seen = new Set<string>()
  for (const e of remote) {
    const id = workoutIdOf(e.external_id)
    if (id === undefined) continue
    const w = byId.get(id)
    // A second event for the same workout (two devices creating at once) is dropped.
    if (!w || seen.has(id)) {
      out.remove.push(e.id)
      continue
    }
    seen.add(id)
    if (!isPlanned(w)) continue
    const event = intervalsEvent(w, speedUnit)
    if (!same(e, event)) out.update.push({ id: e.id, event })
  }
  for (const w of workouts) {
    if (isPlanned(w) && w.date >= from && !seen.has(w.id)) out.create.push(intervalsEvent(w, speedUnit))
  }
  return out
}

/** One reconcile against `api`. Returns how many events were created, updated and deleted. */
export async function reconcile(api: IntervalsApi, from = today()): Promise<{ created: number; updated: number; removed: number }> {
  const remote = (await api.list(from, addDays(from, HORIZON_DAYS))).filter((e) => workoutIdOf(e.external_id) !== undefined)
  const { speedUnit } = await loadSettings()
  const ahead = await db.workouts.where('date').aboveOrEqual(from).toArray()
  // Workouts behind events that are no longer ahead: moved to an earlier date.
  const known = new Set(ahead.map((w) => w.id))
  const others = remote.map((e) => workoutIdOf(e.external_id)!).filter((id) => !known.has(id))
  const moved = (await db.workouts.bulkGet(others)).filter((w): w is Workout => !!w)
  const c = changes([...ahead, ...moved], remote, from, speedUnit)
  if (c.create.length) await api.create(c.create)
  for (const u of c.update) await api.update(u.id, u.event)
  if (c.remove.length) await api.remove(c.remove)
  return { created: c.create.length, updated: c.update.length, removed: c.remove.length }
}

let running: Promise<unknown> | undefined
let again = false

/**
 * Reconciles with the connected account, if there is one. One run at a time; a call during a run makes it
 * run once more afterwards. Call only after the first pull (`whenReady`): a device that hasn't got its
 * workouts yet would delete their events.
 */
export async function syncIntervals(): Promise<void> {
  if (running) {
    again = true
    await running
    return
  }
  const connection = await db.intervalsConnection.get('intervals')
  if (!connection || !navigator.onLine) return
  running = (async () => {
    try {
      do {
        again = false
        await reconcile(intervalsApi(connection.apiKey))
      } while (again)
    } finally {
      running = undefined
    }
  })()
  await running
}

