import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { fmtLongDate } from '../../metrics/dates'
import { stepStats, workoutTotals } from '../../metrics/workout'
import { occurrences } from '../../model/tree'
import type { Block, Settings, Step, Workout } from '../../model/types'
import { KIND_LABEL, SPORT_LABEL } from '../../model/types'
import { amountText, fmtClock, fmtSpeedIn } from '../../parser/format'
import { fmtTargets } from '../../parser/serialize'
import { mainSetSummary } from '../../parser/summary'
import { linkOffset, stepAverage, stepSegments, stepWindows } from '../../recordings/align'
import { effortFor, type EffortKind } from '../../recordings/derived'
import { DetailChart } from '../charts/DetailChart'
import { ZoneLegend } from '../charts/TimelineBar'
import { CopyLinkButton } from '../common/CopyLinkButton'
import { Modal } from '../common/Modal'
import { RecordingSummary } from '../common/RecordingSummary'
import { StatsRow } from '../entry/StatsRow'
import { NoteLines } from './NoteLines'
import { useEnsureStreams } from '../../strava/useStreams'

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

  const recording = useLiveQuery(() => (w.recording ? db.recordings.get(w.recording.id) : undefined), [w.recording?.id])
  useEnsureStreams(w.recording ? [w.recording.id] : [])
  const streams = useLiveQuery(async () => {
    const s = w.recording ? await db.recordingStreams.get(w.recording.id) : undefined
    return s?.t.length ? s : null
  }, [w.recording?.id])
  const offset = linkOffset(w.recording)

  const segments = useMemo(() => stepSegments(w.blocks, w.sport, profile, w.rpe), [w.blocks, w.sport, profile, w.rpe])
  const windows = useMemo(
    () => stepWindows(w.blocks, w.sport, profile, w.rpe, offset),
    [w.blocks, w.sport, profile, w.rpe, offset],
  )
  const hrByStep = useMemo(() => (streams?.hr ? stepAverage(windows, streams.t, streams.hr) : undefined), [streams, windows])

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
    <Modal
      label="Workout"
      onClose={onClose}
      onKeyDown={(e) => {
        // Esc zooms out first.
        if (e.key === 'Escape' && view) {
          e.preventDefault()
          setView(undefined)
        }
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
        <RecordingSummary recording={recording} note={offset !== 0 ? `plan starts at ${fmtClock(offset)}` : undefined} />
      )}

      {w.rawText && <pre className="shorthand-view">{w.rawText}</pre>}
      <StatsRow totals={totals} sport={w.sport} speedUnit={speedUnit} />

      {segments.length > 0 || streams ? (
        <>
          <div className="chart-bar">
            <span className="meta">
              {view ? (
                `Showing ${fmtClock(view[0])}–${fmtClock(view[1])}`
              ) : (
                <>
                  Drag across the chart to zoom in.<span className="hover-only"> Hover for values.</span>
                </>
              )}
            </span>
            {view && <button onClick={() => setView(undefined)}>Reset zoom</button>}
          </div>
          <DetailChart
            segments={segments}
            sport={w.sport}
            speedUnit={speedUnit}
            recording={streams ? { streams, offset } : undefined}
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

      {w.notes?.length ? <NoteLines notes={w.notes} /> : null}

      <footer className="modal-actions">
        <CopyLinkButton link={{ workout: w.id }} />
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={onEdit}>
          Edit
        </button>
      </footer>
    </Modal>
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
          <td>{fmtTargets(b.targets)}</td>
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
