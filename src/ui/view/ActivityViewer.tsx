import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { fmtLongDate } from '../../metrics/dates'
import { stepStats, workoutTotals } from '../../metrics/workout'
import { expand, occurrences } from '../../model/tree'
import type { Block, Settings, Step, Workout } from '../../model/types'
import { KIND_LABEL, SPORT_LABEL } from '../../model/types'
import { amountText, fmtClock, fmtSpeedIn } from '../../parser/format'
import { fmtTarget, TARGET_ORDER } from '../../parser/serialize'
import { mainSetSummary } from '../../parser/summary'
import { linkOffset, stepAverage, stepHr, stepWindows } from '../../recordings/align'
import { effortFor, type EffortKind } from '../../recordings/derived'
import { DetailChart, type Segment } from '../charts/DetailChart'
import { ZoneLegend } from '../charts/TimelineBar'
import { StatsRow } from '../entry/StatsRow'

interface Props {
  workout: Workout
  settings: Settings
  onEdit: () => void
  onClose: () => void
}

/** Read-only view of a logged workout: plan, recording and a zoomable chart. Editing is a separate dialog. */
export function ActivityViewer({ workout: w, settings, onEdit, onClose }: Props) {
  const profile = w.profile ?? settings
  const speedUnit = w.speedUnit ?? settings.speedUnit
  const [view, setView] = useState<[number, number]>()
  // Focus the dialog so Esc works straight away.
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => dialog.current?.focus(), [])

  const recording = useLiveQuery(() => (w.recording ? db.recordings.get(w.recording.id) : undefined), [w.recording?.id])
  const streams = useLiveQuery(async () => {
    const s = w.recording ? await db.recordingStreams.get(w.recording.id) : undefined
    return s?.t.length ? s : null
  }, [w.recording?.id])
  const offset = linkOffset(w.recording)

  const segments = useMemo(() => {
    const out: Segment[] = []
    let at = 0
    for (const step of expand(w.blocks, 2000)) {
      const { duration, zone } = stepStats(step, w.sport, profile, w.rpe)
      if (!duration) continue
      out.push({ step, start: at, duration, zone })
      at += duration
    }
    return out
  }, [w.blocks, w.sport, profile, w.rpe])
  const windows = useMemo(
    () => stepWindows(w.blocks, w.sport, profile, w.rpe, offset),
    [w.blocks, w.sport, profile, w.rpe, offset],
  )
  const hrByStep = useMemo(() => (streams?.hr ? stepHr(windows, streams) : undefined), [streams, windows])

  // GAP, pace or power, whichever suits the sport and the terrain.
  const effort = useMemo(
    () => (streams ? effortFor(streams, w.sport, w.blocks, profile, w.rpe, offset) : undefined),
    [streams, w.sport, w.blocks, profile, w.rpe, offset],
  )
  const effortByStep = useMemo(
    () => (effort && streams ? stepAverage(windows, streams.t, effort.values) : undefined),
    [effort, streams, windows],
  )
  const fmtEffort = (v: number) => (effort?.kind === 'power' ? `${Math.round(v)} W` : fmtSpeedIn(v, speedUnit))
  const totals = workoutTotals(w, profile)
  const title = w.title || mainSetSummary(w.blocks, speedUnit) || 'Workout'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-label="Workout"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          if (view) setView(undefined)
          else onClose()
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <span className="meta">
            {fmtLongDate(w.date)} · {SPORT_LABEL[w.sport]}
            {w.rpe !== undefined && ` · RPE ${w.rpe}`}
          </span>
        </header>

        {recording && (
          <div className="recording-row">
            <span className="label">Recording</span>
            <span>
              <strong>{recording.name ?? recording.rawSport}</strong> ·{' '}
              {new Date(recording.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {fmtClock(recording.elapsed)}
              {recording.distance ? ` · ${(recording.distance / 1000).toFixed(2)} km` : ''}
              {recording.avgHr ? ` · avg HR ${Math.round(recording.avgHr)}` : ''}
              {recording.maxHr ? ` / max ${Math.round(recording.maxHr)}` : ''}
              {offset !== 0 && <span className="meta"> · plan starts at {fmtClock(offset)}</span>}
            </span>
            {recording.stravaId && (
              <a href={`https://www.strava.com/activities/${recording.stravaId}`} target="_blank" rel="noreferrer">
                Strava ↗
              </a>
            )}
          </div>
        )}

        {w.rawText && <pre className="shorthand-view">{w.rawText}</pre>}
        <StatsRow totals={totals} sport={w.sport} speedUnit={speedUnit} />

        {segments.length > 0 || streams ? (
          <>
            <div className="chart-bar">
              <span className="meta">
                {view
                  ? `Showing ${fmtClock(view[0])}–${fmtClock(view[1])}`
                  : 'Drag across the chart to zoom in. Hover for values.'}
              </span>
              {view && <button onClick={() => setView(undefined)}>Reset zoom</button>}
            </div>
            <DetailChart
              segments={segments}
              sport={w.sport}
              speedUnit={speedUnit}
              hr={streams ? { streams, offset } : undefined}
              effort={effort}
              view={view}
              onView={setView}
            />
            <div className="timeline-caption">
              <span>
                Height = zone{streams?.hr ? ' · red line = recorded HR (bpm)' : ''}
                {effort && ` · grey line = ${EFFORT_CAPTION[effort.kind]} (right axis), dashed = plan`}
              </span>
              <ZoneLegend />
            </div>
          </>
        ) : (
          <div className="empty">No timed steps yet.</div>
        )}

        <StepList
          blocks={w.blocks}
          hr={hrByStep}
          effort={effort && effortByStep && { label: EFFORT_LABEL[effort.kind], byStep: effortByStep, format: fmtEffort }}
          zoneOf={(s) => stepStats(s, w.sport, profile, w.rpe).zone}
        />

        {w.notes && <p className="notes-view">{w.notes}</p>}

        <footer className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={onEdit}>
            Edit
          </button>
        </footer>
      </div>
    </div>
  )
}

const EFFORT_LABEL: Record<EffortKind, string> = { gap: 'GAP', pace: 'Pace', power: 'Power' }
const EFFORT_CAPTION: Record<EffortKind, string> = {
  gap: 'GAP (Minetti 2002)',
  pace: 'pace (GAP within 5% overall)',
  power: 'power (W)',
}

/** The plan as a read-only table, with recorded averages per step (HR, and GAP, pace or power) when there are any. */
function StepList({
  blocks,
  hr,
  effort,
  zoneOf,
}: {
  blocks: Block[]
  hr?: Map<Step, number>
  effort?: { label: string; byStep: Map<Step, number>; format: (v: number) => string }
  zoneOf: (s: Step) => number
}) {
  if (!blocks.length) return null
  const counts = occurrences(blocks)
  const rows: ReactNode[] = []
  const visit = (list: Block[], key: string, depth: number) =>
    list.forEach((b, i) => {
      const k = `${key}.${i}`
      const indent = { paddingLeft: 8 + depth * 16 }
      if (b.type === 'repeat') {
        rows.push(
          <tr key={k} className="repeat-row">
            <td style={indent} colSpan={6}>
              {b.count} ×{b.skipLastRest ? ' · final rest dropped' : ''}
            </td>
          </tr>,
        )
        visit(b.children, k, depth + 1)
        return
      }
      const count = counts.get(b) ?? 0
      rows.push(
        <tr key={k}>
          <td style={indent}>{KIND_LABEL[b.kind]}</td>
          <td>{amountText(b)}</td>
          <td>{TARGET_ORDER.map((t) => fmtTarget(t, b.targets)).filter(Boolean).join(', ')}</td>
          <td className="computed">
            {b.kind === 'pause' ? 'not counted' : `Z${zoneOf(b)}`}
            {count !== 1 ? ` · ×${count}` : ''}
          </td>
          <td className="num">{hr?.has(b) ? Math.round(hr.get(b)!) : ''}</td>
          <td className="num">{effort?.byStep.has(b) ? effort.format(effort.byStep.get(b)!) : ''}</td>
        </tr>,
      )
    })
  visit(blocks, '', 0)
  return (
    <table className="steps step-list">
      <thead>
        <tr>
          <th>Step</th>
          <th>Amount</th>
          <th>Targets</th>
          <th>Zone</th>
          <th className="num">{hr ? 'HR' : ''}</th>
          <th className="num">{effort?.label ?? ''}</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  )
}
