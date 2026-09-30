import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from './db/db'
import { addDays, fmtWeekRange, isoWeek, today, weekStart } from './metrics/dates'
import { acuteChronicRatio, summarizeWeeks } from './metrics/week'
import { DEFAULT_SETTINGS, profileOf, type Recording, type RecordingStreams, type Workout } from './model/types'
import { autoLogRecordings, detectText } from './recordings/autolog'
import { handleCallback } from './strava/auth'
import { useWeekSync } from './strava/useWeekSync'
import { WorkoutEditor, type Draft } from './ui/entry/WorkoutEditor'
import { ActivityViewer } from './ui/view/ActivityViewer'
import { SettingsDialog } from './ui/settings/SettingsDialog'
import { GapCalculator } from './ui/tools/GapCalculator'
import { WeekPanels } from './ui/week/WeekPanels'
import { WeekTable } from './ui/week/WeekTable'

const TREND_WEEKS = 12

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export default function App() {
  const [start, setStart] = useState(() => weekStart(today()))
  const [editing, setEditing] = useState<Draft | null>(null)
  // The workout open in the viewer. Editing from there returns to it afterwards.
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showGap, setShowGap] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Finish the Strava OAuth redirect, if this load is one.
  useEffect(() => {
    void handleCallback().then((r) => {
      if (r && !r.ok) setConnectError(r.error)
    })
  }, [])

  // Log runs and rides imported before auto-logging existed, or whose streams arrived late.
  useEffect(() => {
    void db.recordings.toArray().then(autoLogRecordings)
  }, [])

  // ← / → move between weeks, unless a dialog is open or a field has focus.
  const overlayOpen = !!editing || !!viewingId || showSettings || showGap
  useEffect(() => {
    if (overlayOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const step = e.key === 'ArrowLeft' ? -7 : e.key === 'ArrowRight' ? 7 : 0
      if (!step) return
      e.preventDefault()
      setStart((s) => addDays(s, step))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayOpen])

  // null once loaded with nothing saved; undefined while loading.
  const stored = useLiveQuery(async () => (await db.settings.get('settings')) ?? null, [])
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...stored }), [stored])
  const strava = useLiveQuery(async () => (await db.stravaAuth.get('strava')) ?? null, [])

  const trendFrom = addDays(start, -7 * (TREND_WEEKS - 1))
  const weekEnd = addDays(start, 6)
  const workouts = useLiveQuery(
    () => db.workouts.where('date').between(trendFrom, weekEnd, true, true).toArray(),
    [trendFrom, weekEnd],
  )
  const recordings = useLiveQuery(
    () => db.recordings.where('localDate').between(start, weekEnd, true, true).sortBy('startTime'),
    [start, weekEnd],
  )
  const lastFetch = useLiveQuery(() => db.stravaWeekFetch.get(start), [start])
  const lastSport = useLiveQuery(() => db.workouts.orderBy('updatedAt').last(), [])?.sport
  const sync = useWeekSync(start, !!strava)

  const weeks = summarizeWeeks(start, TREND_WEEKS, workouts ?? [], settings)
  const weekWorkouts = useMemo(() => (workouts ?? []).filter((w) => w.date >= start), [workouts, start])
  const isThisWeek = start === weekStart(today())
  const isFuture = start > weekStart(today())
  const viewing = viewingId ? workouts?.find((w) => w.id === viewingId) : undefined
  // HR samples for this week's linked recordings, for the timelines.
  const linkedIds = weekWorkouts.flatMap((w) => (w.recording ? [w.recording.id] : [])).sort()
  const streams = useLiveQuery(async () => {
    const rows = await db.recordingStreams.bulkGet(linkedIds)
    return new Map(rows.flatMap((s): [string, RecordingStreams][] => (s ? [[s.recordingId, s]] : [])))
  }, [linkedIds.join()])

  const addOn = (date: string) => setEditing({ date, sport: lastSport ?? 'run' })
  const open = (w: Workout) => setViewingId(w.id)
  const logRecording = async (r: Recording) => {
    const detected = detectText(r, await db.recordingStreams.get(r.id), profileOf(settings))
    setEditing({
      date: r.localDate,
      sport: r.sport,
      title: r.name,
      ...(detected ? { ...detected, generated: true, speedUnit: r.sport === 'run' ? 'pace' : undefined } : { duration: r.elapsed }),
      recording: { id: r.id, linkedBy: 'manual', alignment: { method: 'offset', offset: 0 } },
    })
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>
          Week {isoWeek(start)} <span className="range">{fmtWeekRange(start)}</span>
        </h1>
        <div className="btn-group">
          <button onClick={() => setStart(addDays(start, -7))} aria-label="Previous week">
            ‹
          </button>
          <button onClick={() => setStart(addDays(start, 7))} aria-label="Next week">
            ›
          </button>
        </div>
        <button onClick={() => setStart(weekStart(today()))} disabled={isThisWeek}>
          Today
        </button>
        <span className="spacer" />
        {strava && (
          <span className="sync-status">
            <span className="meta">
              {sync.syncing ? 'Syncing Strava…' : lastFetch ? `Strava synced ${ago(lastFetch.fetchedAt)}` : 'Strava'}
            </span>
            <button className="icon" onClick={sync.refresh} disabled={sync.syncing || isFuture} title="Refresh from Strava">
              ⟳
            </button>
          </span>
        )}
        <button onClick={() => setShowGap(true)}>GAP calculator</button>
        <button onClick={() => setShowSettings(true)}>Settings</button>
        <button className="primary" onClick={() => addOn(isThisWeek ? today() : start)}>
          + Add workout
        </button>
      </header>

      {connectError && (
        <p className="notice">
          Couldn&rsquo;t connect Strava: {connectError}{' '}
          <button className="link" onClick={() => setConnectError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {sync.error && <p className="notice">Strava sync failed: {sync.error}</p>}
      {sync.result?.status === 'rate-limited' && (
        <p className="notice">Strava&rsquo;s rate limit was reached; some heart-rate data will load on a later visit.</p>
      )}
      {stored !== undefined && !settings.thresholdSpeed && (
        <p className="notice">
          Threshold pace isn&rsquo;t set, so pace-based zones are off.{' '}
          <button className="link" onClick={() => setShowSettings(true)}>
            Set it in Settings
          </button>
        </p>
      )}

      <WeekTable
        start={start}
        workouts={weekWorkouts}
        recordings={recordings ?? []}
        streams={streams ?? new Map()}
        summary={weeks[weeks.length - 1]}
        acwr={acuteChronicRatio(weeks)}
        settings={settings}
        onOpen={open}
        onAdd={addOn}
        onLogRecording={logRecording}
      />
      <WeekPanels weeks={weeks} onSelectWeek={setStart} />

      {viewing && !editing && (
        <ActivityViewer
          workout={viewing}
          settings={settings}
          onEdit={() => setEditing(viewing)}
          onClose={() => setViewingId(null)}
        />
      )}
      {editing && <WorkoutEditor draft={editing} settings={settings} onClose={() => setEditing(null)} />}
      {showGap && <GapCalculator speedUnit={settings.speedUnit} onClose={() => setShowGap(false)} />}
      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
