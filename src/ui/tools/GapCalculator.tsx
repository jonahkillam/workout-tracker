import { useState } from 'react'
import { gradeAdjustedSpeed, speedForGap } from '../../metrics/workout'
import type { SpeedUnit } from '../../model/types'
import { fmtSpeedIn, parsePaceInput } from '../../parser/format'

interface Props {
  speedUnit: SpeedUnit
  onClose: () => void
}

type Direction = 'toFlat' | 'toIncline'

const INCLINES = [0, 2, 4, 6, 8, 10, 12, 15, 20]

/** Reads "8.5" in the chosen unit, or "4:30" as a pace; returns km/h. */
function parseSpeed(text: string, unit: SpeedUnit): number | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (t.includes(':') || unit === 'pace') return parsePaceInput(t)
  const v = Number(t.replace(/\s*km\/h$/, ''))
  return v > 0 ? v : undefined
}

/**
 * Converts between treadmill speed at an incline and the flat pace with the same
 * energy cost (grade-adjusted pace), using the Minetti (2002) cost of running.
 */
export function GapCalculator({ speedUnit, onClose }: Props) {
  const [direction, setDirection] = useState<Direction>('toFlat')
  const [unit, setUnit] = useState<SpeedUnit>(speedUnit)
  const [speedText, setSpeedText] = useState('')
  const [inclineText, setInclineText] = useState('10')

  const speed = parseSpeed(speedText, unit)
  const grade = Number(inclineText) / 100
  const validGrade = inclineText.trim() !== '' && Number.isFinite(grade) && Math.abs(grade) <= 0.45
  const convert = (kmh: number, g: number) => (direction === 'toFlat' ? gradeAdjustedSpeed(kmh, g) : speedForGap(kmh, g))
  const result = speed && validGrade ? convert(speed, grade) : undefined
  const both = (kmh: number) =>
    `${fmtSpeedIn(kmh, unit)} (${fmtSpeedIn(kmh, unit === 'pace' ? 'kmh' : 'pace')})`

  const inputLabel = direction === 'toFlat' ? 'Treadmill speed' : 'Target flat pace'
  const resultLabel = direction === 'toFlat' ? 'Grade-adjusted pace' : 'Treadmill speed'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal narrow"
        role="dialog"
        aria-label="GAP calculator"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <header className="modal-head">
          <h2>GAP calculator</h2>
          <span className="spacer" />
          <span className="segmented" role="group" aria-label="Direction">
            <button aria-pressed={direction === 'toFlat'} onClick={() => setDirection('toFlat')}>
              Incline → flat
            </button>
            <button aria-pressed={direction === 'toIncline'} onClick={() => setDirection('toIncline')}>
              Flat → incline
            </button>
          </span>
        </header>

        <div className="form-row">
          <label className="field">
            <span>
              {inputLabel} ({unit === 'pace' ? 'min/km' : 'km/h'})
            </span>
            <input
              autoFocus
              value={speedText}
              onChange={(e) => setSpeedText(e.target.value)}
              placeholder={unit === 'pace' ? '5:30' : '8.5'}
              aria-invalid={speedText.trim() !== '' && !speed}
              style={{ width: 120 }}
            />
          </label>
          <span className="segmented" role="group" aria-label="Unit" style={{ marginBottom: 2 }}>
            {(['kmh', 'pace'] as const).map((u) => (
              <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                {u === 'kmh' ? 'km/h' : 'min/km'}
              </button>
            ))}
          </span>
          <label className="field">
            <span>Incline (%)</span>
            <input
              type="number"
              step={0.5}
              min={-45}
              max={45}
              value={inclineText}
              onChange={(e) => setInclineText(e.target.value)}
              aria-invalid={!validGrade}
              style={{ width: 80 }}
            />
          </label>
        </div>

        <div className="stats-row">
          <div>
            <span className="label">{resultLabel}</span>
            <span className="value">{result ? both(result) : '—'}</span>
          </div>
        </div>

        {speed && (
          <table className="steps">
            <thead>
              <tr>
                <th>Incline</th>
                <th>{direction === 'toFlat' ? `GAP at ${fmtSpeedIn(speed, unit)}` : `Speed for ${fmtSpeedIn(speed, unit)} flat`}</th>
              </tr>
            </thead>
            <tbody>
              {INCLINES.map((i) => (
                <tr key={i} className={validGrade && Math.abs(grade * 100 - i) < 1e-9 ? 'current' : undefined}>
                  <td>{i}%</td>
                  <td>{both(convert(speed, i / 100))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="help" style={{ marginTop: 10 }}>
          Uses the Minetti et al. (2002) energy cost of running on a grade. Other models, such as Strava&rsquo;s
          heart-rate-based GAP, can differ noticeably on steep grades.
        </p>

        <footer className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
