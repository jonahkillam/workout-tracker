import { useMemo, type ReactNode } from 'react'
import { fmtDay, today, weekDays } from '../../metrics/dates'
import type { WeekSummary } from '../../metrics/week'
import { workoutTotals, type Totals } from '../../metrics/workout'
import type { Recording, RecordingStreams, Settings, Workout } from '../../model/types'
import { SPORT_LABEL, SPORTS } from '../../model/types'
import { fmtHours, num } from '../../parser/format'
import { linkOffset } from '../../recordings/align'
import { effortFor, type Effort } from '../../recordings/derived'
import { mainSetSummary } from '../../parser/summary'
import { TimelineBar } from '../charts/TimelineBar'

interface Props {
  start: string
  workouts: Workout[]
  /** Recordings in the week, linked or not. */
  recordings: Recording[]
  /** Per-sample data for the linked recordings, by recording id. */
  streams: Map<string, RecordingStreams>
  summary: WeekSummary
  acwr?: number
  settings: Settings
  onOpen: (w: Workout) => void
  onAdd: (date: string) => void
  onLogRecording: (r: Recording) => void
}

type Cells = Pick<Totals, 'duration' | 'distance' | 'vertical' | 'load'> & { hr?: number }

function NumberCells({ t, stair }: { t: Cells; stair?: boolean }) {
  return (
    <>
      <td className="num">{t.duration ? fmtHours(t.duration) : '—'}</td>
      <td className="num wide-only">{stair || !t.distance ? '—' : num(t.distance / 1000, 1)}</td>
      <td className="num wide-only">{t.vertical >= 1 ? Math.round(t.vertical).toLocaleString() : '—'}</td>
      <td className="num">{t.hr ? Math.round(t.hr) : '—'}</td>
      <td className="num">{t.load ? Math.round(t.load) : '—'}</td>
    </>
  )
}

const stravaUrl = (r: Recording) => (r.stravaId ? `https://www.strava.com/activities/${r.stravaId}` : undefined)

export function WeekTable({ start, workouts, recordings, streams, summary, acwr, settings, onOpen, onAdd, onLogRecording }: Props) {
  const now = today()
  const byId = new Map(recordings.map((r) => [r.id, r]))
  const linked = new Set(workouts.map((w) => w.recording?.id).filter(Boolean))
  const rows: ReactNode[] = []
  // GAP, pace or power per linked workout, for the timelines.
  const efforts = useMemo(() => {
    const out = new Map<string, Effort>()
    for (const w of workouts) {
      const s = w.recording && streams.get(w.recording.id)
      const e = s && effortFor(s, w.sport, w.blocks, w.profile ?? settings, w.rpe, linkOffset(w.recording))
      if (e) out.set(w.id, e)
    }
    return out
  }, [workouts, streams, settings])

  for (const date of weekDays(start)) {
    const sessions = workouts.filter((w) => w.date === date).sort((a, b) => a.createdAt - b.createdAt)
    const unlogged = recordings.filter((r) => r.localDate === date && !linked.has(r.id))
    const span = sessions.length + unlogged.length
    const { weekday, day } = fmtDay(date)
    const dayCell = (
      <td rowSpan={Math.max(1, span)} className={`day${date === now ? ' today' : ''}`}>
        <div className="dow">{weekday}</div>
        <div className="dom">{day}</div>
        <button
          className="link add"
          onClick={(e) => {
            e.stopPropagation()
            onAdd(date)
          }}
          aria-label={`Add a workout on ${weekday} ${day}`}
        >
          + add
        </button>
      </td>
    )

    if (!span) {
      rows.push(
        <tr key={date} className="day-start empty-day">
          {dayCell}
          <td className="wide-only" />
          <td colSpan={6} />
        </tr>,
      )
      continue
    }

    sessions.forEach((w, i) => {
      const profile = w.profile ?? settings
      const t = workoutTotals(w, profile)
      const rec = w.recording ? byId.get(w.recording.id) : undefined
      const recStreams = w.recording && streams.get(w.recording.id)
      const mainSet = mainSetSummary(w.blocks, w.speedUnit ?? settings.speedUnit)
      const subline = [mainSet && w.title, w.rpe !== undefined && `RPE ${w.rpe}`].filter(Boolean) as string[]
      const url = rec && stravaUrl(rec)
      rows.push(
        <tr key={w.id} className={`session${i === 0 ? ' day-start' : ''}`} onClick={() => onOpen(w)}>
          {i === 0 && dayCell}
          <td className="sport wide-only">{SPORT_LABEL[w.sport]}</td>
          <td className="detail">
            <button
              className={`link headline${mainSet ? ' main-set' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onOpen(w)
              }}
            >
              {mainSet || w.title || 'Untitled'}
            </button>
            {(subline.length > 0 || url) && (
              <div className="subline">
                {subline.join(' · ')}
                {url && (
                  <>
                    {subline.length > 0 && ' · '}
                    <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      Strava ↗
                    </a>
                  </>
                )}
              </div>
            )}
            <TimelineBar
              blocks={w.blocks}
              sport={w.sport}
              profile={profile}
              rpe={w.rpe}
              height={30}
              mini
              hr={recStreams ? { streams: recStreams, offset: linkOffset(w.recording) } : undefined}
              effort={efforts.get(w.id)}
            />
            {w.notes && <div className="notes">{w.notes}</div>}
          </td>
          <NumberCells t={{ ...t, hr: rec?.avgHr }} stair={w.sport === 'stair'} />
        </tr>,
      )
    })

    unlogged.forEach((r, i) => {
      const first = sessions.length === 0 && i === 0
      const url = stravaUrl(r)
      rows.push(
        <tr key={r.id} className={`unlogged${first ? ' day-start' : ''}`}>
          {first && dayCell}
          <td className="sport wide-only">{SPORT_LABEL[r.sport]}</td>
          <td className="detail">
            <span className="headline">{r.name ?? r.rawSport}</span>
            <div className="subline">
              Not logged ·{' '}
              <button className="link" onClick={() => onLogRecording(r)}>
                Log it
              </button>
              {url && (
                <>
                  {' · '}
                  <a href={url} target="_blank" rel="noreferrer">
                    Strava ↗
                  </a>
                </>
              )}
            </div>
          </td>
          <NumberCells
            t={{ duration: r.elapsed, distance: r.distance ?? 0, vertical: r.elevationGain ?? 0, load: 0, hr: r.avgHr }}
            stair={r.sport === 'stair'}
          />
        </tr>,
      )
    })
  }

  const sports = SPORTS.filter((s) => summary.bySport[s])

  return (
    <table className="week">
      <thead>
        <tr>
          <th className="c-day">Day</th>
          <th className="c-sport wide-only">Sport</th>
          <th>Session</th>
          <th className="num c-n">Time</th>
          <th className="num c-n wide-only">km</th>
          <th className="num c-n wide-only">Climb m</th>
          <th className="num c-hr" title="Average heart rate from the linked recording">
            HR
          </th>
          <th className="num c-n">Load</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
      <tfoot>
        {sports.length > 1 &&
          sports.map((s) => {
            const t = summary.bySport[s]!
            return (
              <tr key={s} className="subtotal">
                <td />
                <td className="wide-only" />
                <td>
                  {SPORT_LABEL[s]}{' '}
                  <span className="meta">
                    · {t.count} session{t.count === 1 ? '' : 's'}
                  </span>
                </td>
                <NumberCells t={t} stair={s === 'stair'} />
              </tr>
            )
          })}
        <tr className="total">
          <td>Total</td>
          <td className="wide-only" />
          <td className="meta">
            {sports.reduce((n, s) => n + summary.bySport[s]!.count, 0)} sessions
            {acwr !== undefined && (
              <span className={acwr > 1.5 ? 'warn' : undefined} title="Load this week ÷ average of the previous 4 weeks">
                {' '}
                · load {num(acwr)}× 4-wk avg
              </span>
            )}
          </td>
          <NumberCells t={summary.total} />
        </tr>
      </tfoot>
    </table>
  )
}
