import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { db } from './db/db'
import { addDays, fmtWeekRange, isoWeek, today, weekStart } from './metrics/dates'
import { acuteChronicRatio, summarizeWeeks } from './metrics/week'
import { DEFAULT_SETTINGS, profileOf, type Recording, type RecordingStreams, type Workout } from './model/types'
import { autoLogRecordings, detectText } from './recordings/autolog'
import { newLink } from './recordings/match'
import { fillRecordedSummaries } from './recordings/recorded'
import { handleCallback } from './strava/auth'
import { useEnsureStreams } from './strava/useStreams'
import { useWeekSync } from './strava/useWeekSync'
import { whenReady } from './sync/engine'
import { useSyncStatus } from './sync/useSyncStatus'
import { WorkoutEditor, type Draft } from './ui/entry/WorkoutEditor'
import { ActivityViewer } from './ui/view/ActivityViewer'
import { SettingsDialog } from './ui/settings/SettingsDialog'
import { GapCalculator } from './ui/tools/GapCalculator'
import { WeekPanels } from './ui/week/WeekPanels'
import { useSwipe } from './ui/common/useSwipe'
import { Logo } from './ui/Logo'
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

  // Wait for the first pull after sign-in before anything that writes, so this device sees what others did
  // (e.g. which recordings were already auto-logged) first.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void (async () => {
      await whenReady()
      setReady(true)
      // Summarise and log recordings imported before those existed, or whose streams arrived late.
      await fillRecordedSummaries(await db.recordings.toArray())
      await autoLogRecordings(await db.recordings.toArray())
    })()
  }, [])

  // Changing week slides the old one out, then the new one in once its data has loaded (below).
  const slideRef = useRef<HTMLDivElement>(null)
  const sliding = useRef<-1 | 0 | 1>(0)
  const goTo = (to: string) => {
    if (to === start) return
    const el = slideRef.current
    // Switch at once if a slide is already running, or the user prefers reduced motion.
    if (!el || sliding.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setStart(to)
    const dir = to > start ? 1 : -1
    sliding.current = dir
    el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translateX(${-32 * dir}px)`, opacity: 0 },
      ],
      { duration: 110, easing: 'ease-in', fill: 'forwards' },
    ).finished.then(
      () => setStart(to),
      () => {}, // cancelled by a later change
    )
  }
  const step = useRef((_days: number) => {})
  useEffect(() => {
    step.current = (days) => goTo(addDays(start, days))
  })

  // ← / → move between weeks, unless a dialog is open or a field has focus.
  const overlayOpen = !!editing || !!viewingId || showSettings || showGap
  useEffect(() => {
    if (overlayOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      const days = e.key === 'ArrowLeft' ? -7 : e.key === 'ArrowRight' ? 7 : 0
      if (!days) return
      e.preventDefault()
      step.current(days)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlayOpen])
  // On touch screens, so do sideways swipes.
  useSwipe((dir) => step.current(7 * dir), !overlayOpen)

  // null once loaded with nothing saved; undefined while loading.
  const stored = useLiveQuery(async () => (await db.settings.get('settings')) ?? null, [])
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...stored }), [stored])
  const strava = useLiveQuery(async () => (await db.stravaConnection.get('strava')) ?? null, [])

  const trendFrom = addDays(start, -7 * (TREND_WEEKS - 1))
  const weekEnd = addDays(start, 6)
  // Tagged with its week: until a new week's query resolves, this still holds the previous week's rows.
  const data = useLiveQuery(
    async () => ({
      start,
      workouts: await db.workouts.where('date').between(trendFrom, weekEnd, true, true).toArray(),
      recordings: await db.recordings.where('localDate').between(trendFrom, weekEnd, true, true).sortBy('startTime'),
    }),
    [start, trendFrom, weekEnd],
  )
  const workouts = data?.workouts
  const recordings = data?.recordings
  const loaded = data?.start === start
  useLayoutEffect(() => {
    const el = slideRef.current
    const dir = sliding.current
    if (!el || !dir || !loaded) return
    sliding.current = 0
    el.getAnimations().forEach((a) => a.cancel())
    el.animate(
      [
        { transform: `translateX(${32 * dir}px)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 160, easing: 'ease-out' },
    )
  }, [loaded, start])
  const lastFetch = useLiveQuery(() => db.stravaWeekFetch.get(start), [start])
  const sync = useWeekSync(start, ready && !!strava)
  const account = useSyncStatus()

  const weeks = useMemo(
    () => summarizeWeeks(start, TREND_WEEKS, workouts ?? [], settings, recordings ?? []),
    [start, workouts, settings, recordings],
  )
  const weekWorkouts = useMemo(() => (workouts ?? []).filter((w) => w.date >= start), [workouts, start])
  const weekRecordings = useMemo(() => (recordings ?? []).filter((r) => r.localDate >= start), [recordings, start])
  const isThisWeek = start === weekStart(today())
  const isFuture = start > weekStart(today())
  const viewing = viewingId ? workouts?.find((w) => w.id === viewingId) : undefined
  // Close the viewer once its workout is gone: deleted, or moved out of these weeks by an edit.
  if (viewingId && workouts && !viewing) setViewingId(null)
  // Per-sample data for this week's recordings, for the timelines.
  const recordingIds = [
    ...new Set([...weekWorkouts.flatMap((w) => (w.recording ? [w.recording.id] : [])), ...weekRecordings.map((r) => r.id)]),
  ].sort()
  useEnsureStreams(recordingIds)
  const streams = useLiveQuery(async () => {
    const rows = await db.recordingStreams.bulkGet(recordingIds)
    return new Map(rows.flatMap((s): [string, RecordingStreams][] => (s ? [[s.recordingId, s]] : [])))
  }, [recordingIds.join()])

  const open = (w: Workout) => setViewingId(w.id)
  const logRecording = async (r: Recording) => {
    // Zoned with the thresholds of the time, if the recording has them.
    const profile = r.profile ?? profileOf(settings)
    const detected = detectText(r, await db.recordingStreams.get(r.id), profile)
    setEditing({
      date: r.localDate,
      sport: r.sport,
      title: r.name,
      profile,
      ...(detected
        ? { rawText: detected.rawText, blocks: detected.blocks, speedUnit: r.sport === 'run' ? 'pace' : undefined }
        : { duration: r.moving ?? r.elapsed }),
      recording: newLink(r.id, 'manual'),
    })
  }

  return (
    <div className="app">
      <header className="toolbar">
        <Logo size={20} />
        <h1>
          Week {isoWeek(start)} <span className="range">{fmtWeekRange(start)}</span>
        </h1>
        <div className="btn-group hover-only">
          <button onClick={() => goTo(addDays(start, -7))} aria-label="Previous week">
            ‹
          </button>
          <button onClick={() => goTo(addDays(start, 7))} aria-label="Next week">
            ›
          </button>
        </div>
        <button onClick={() => goTo(weekStart(today()))} disabled={isThisWeek}>
          Today
        </button>
        <span className="spacer" />
        <span className="sync-status meta" title={account.error}>
          {account.syncing
            ? 'Saving…'
            : account.pending && account.error
              ? `${navigator.onLine ? 'Sync failed' : 'Offline'}, ${account.pending} unsaved`
              : account.lastSyncedAt
                ? `Saved ${ago(account.lastSyncedAt)}`
                : ''}
        </span>
        {strava && (
          <span className="sync-status">
            <span className="meta">
              {sync.syncing ? (
                'Syncing Strava…'
              ) : lastFetch ? (
                <>
                  Strava <span className="wide-only">synced </span>
                  {ago(lastFetch.fetchedAt)}
                </>
              ) : (
                'Strava'
              )}
            </span>
            <button className="icon" onClick={sync.refresh} disabled={sync.syncing || isFuture} title="Refresh from Strava">
              ⟳
            </button>
          </span>
        )}
        <button onClick={() => setShowGap(true)}>
          GAP<span className="wide-only"> calculator</span>
        </button>
        <button onClick={() => setShowSettings(true)}>Settings</button>
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

      <div ref={slideRef}>
        <WeekTable
          start={start}
          workouts={weekWorkouts}
          recordings={weekRecordings}
          streams={streams ?? new Map()}
          summary={weeks[weeks.length - 1]}
          acwr={acuteChronicRatio(weeks)}
          settings={settings}
          onOpen={open}
          onLogRecording={logRecording}
        />
        <WeekPanels weeks={weeks} onSelectWeek={goTo} />
      </div>

      {viewing && !editing && (
        <ActivityViewer
          workout={viewing}
          settings={settings}
          onEdit={() => setEditing(viewing)}
          onClose={() => setViewingId(null)}
        />
      )}
      {editing && <WorkoutEditor draft={editing} settings={settings} onClose={() => setEditing(null)} />}
      {showGap && <GapCalculator settings={settings} onClose={() => setShowGap(false)} />}
      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
