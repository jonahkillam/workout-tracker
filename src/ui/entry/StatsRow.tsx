import { averageGap, type Totals } from '../../metrics/workout'
import type { SpeedUnit, Sport } from '../../model/types'
import { fmtClock, fmtHours, fmtSpeedIn, num } from '../../parser/format'

/** Planned totals for a workout: time, distance, climb, GAP, load and zones. */
export function StatsRow({ totals, sport, speedUnit }: { totals: Totals; sport: Sport; speedUnit: SpeedUnit }) {
  const running = sport === 'run' || sport === 'treadmill'
  return (
    <div className="stats-row">
      <div>
        <span className="label">Time</span>
        <span className="value">{totals.duration ? fmtClock(totals.duration) : '—'}</span>
      </div>
      {sport !== 'stair' && (
        <div>
          <span className="label">Distance</span>
          <span className="value">{totals.distance ? `${num(totals.distance / 1000)} km` : '—'}</span>
        </div>
      )}
      <div>
        <span className="label">Climb</span>
        <span className="value">{Math.round(totals.vertical)} m</span>
      </div>
      {running && averageGap(totals) && (
        <div title="Average grade-adjusted pace: the flat pace with the same energy cost (Minetti 2002)">
          <span className="label">Avg GAP</span>
          <span className="value">{fmtSpeedIn(averageGap(totals)!, speedUnit)}</span>
        </div>
      )}
      {running && totals.vertical > 0 && (
        <div title="Flat-equivalent distance, from the Minetti (2002) energy cost of running on a grade">
          <span className="label">Flat equiv.</span>
          <span className="value">{num(totals.flatDistance / 1000)} km</span>
        </div>
      )}
      <div>
        <span className="label">Load</span>
        <span className="value">{Math.round(totals.load)}</span>
      </div>
      <div>
        <span className="label">Zones</span>
        <span className="value small">
          {totals.zoneTime.map((s, i) => (s ? `Z${i + 1} ${fmtHours(s)}` : null)).filter(Boolean).join(' · ') || '—'}
        </span>
      </div>
    </div>
  )
}
