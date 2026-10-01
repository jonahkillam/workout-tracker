import type { ReactNode } from 'react'
import type { Recording } from '../../model/types'
import { fmtClock } from '../../parser/format'
import { fmtStart, stravaUrl } from './recording'

interface Props {
  recording: Recording
  /** Extra detail after the summary, in grey. */
  note?: ReactNode
  /** Controls at the end of the row. */
  children?: ReactNode
}

/** One line about a workout's recording: name, start, time, distance, HR and a Strava link, then any controls. */
export function RecordingSummary({ recording: r, note, children }: Props) {
  const url = stravaUrl(r)
  const hr = [r.avgHr && `avg HR ${Math.round(r.avgHr)}`, r.maxHr && `max ${Math.round(r.maxHr)}`]
    .filter(Boolean)
    .join(' / ')
  return (
    <div className="recording-row">
      <span className="label">Recording</span>
      <span>
        <strong>{r.name ?? r.rawSport}</strong> · {fmtStart(r)} · {fmtClock(r.elapsed)}
        {r.distance ? ` · ${(r.distance / 1000).toFixed(2)} km` : ''}
        {hr && ` · ${hr}`}
        {note && <span className="meta"> · {note}</span>}
      </span>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          Strava ↗
        </a>
      )}
      {children}
    </div>
  )
}
