import { useState } from 'react'
import { climbRate, gradeAdjustedSpeed, speedForGap, stairClimbRate, stairGap } from '../../metrics/workout'
import type { Settings, SpeedUnit } from '../../model/types'
import { fmtSpeedIn, num, parsePaceInput } from '../../parser/format'
import { Modal } from '../common/Modal'
import { SpeedUnitToggle } from '../common/SpeedUnitToggle'

interface Props {
  settings: Settings
  onClose: () => void
}

type Machine = 'treadmill' | 'stair'
type Direction = 'forward' | 'inverse'

const INCLINES = [0, 2, 4, 6, 8, 10, 12, 15, 20]
const STEP_RATES = [40, 50, 60, 70, 80, 90, 100, 110, 120]

/** Reads "8.5" in the chosen unit, or "4:30" as a pace; returns km/h. */
function parseSpeed(text: string, unit: SpeedUnit): number | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (t.includes(':') || unit === 'pace') return parsePaceInput(t)
  const v = Number(t.replace(/\s*km\/h$/, ''))
  return v > 0 ? v : undefined
}

function positive(text: string): number | undefined {
  const v = Number(text)
  return text.trim() !== '' && v > 0 ? v : undefined
}

const perHour = (m: number) => `${Math.round(m)} m/h`

/**
 * Treadmill: converts between speed at an incline and the flat pace with the same energy cost
 * (grade-adjusted pace), using the Minetti (2002) cost of running, and shows the climb rate.
 * Stair climber: converts between step rate and climb rate.
 */
export function GapCalculator({ settings, onClose }: Props) {
  const [machine, setMachine] = useState<Machine>('treadmill')
  const [direction, setDirection] = useState<Direction>('forward')
  const [unit, setUnit] = useState<SpeedUnit>(settings.speedUnit)
  const [speedText, setSpeedText] = useState('')
  const [inclineText, setInclineText] = useState('10')
  const [rateText, setRateText] = useState('')
  const [stepHeightText, setStepHeightText] = useState(String(settings.stairStepHeight))

  const grade = Number(inclineText) / 100
  const validGrade = inclineText.trim() !== '' && Number.isFinite(grade) && Math.abs(grade) <= 0.45

  // The rate field means steps per minute one way and metres per hour the other, so a flip clears it.
  const switchDirection = (d: Direction) => {
    if (d !== direction) setRateText('')
    setDirection(d)
  }

  const switchMachine = (m: Machine) => {
    setMachine(m)
    switchDirection('forward')
  }

  return (
    <Modal label="GAP calculator" className="narrow calc" onClose={onClose}>
      <header className="modal-head">
        <h2>GAP calculator</h2>
        <span className="spacer" />
        <span className="segmented" role="group" aria-label="Machine">
          <button aria-pressed={machine === 'treadmill'} onClick={() => switchMachine('treadmill')}>
            Treadmill
          </button>
          <button aria-pressed={machine === 'stair'} onClick={() => switchMachine('stair')}>
            Stair climber
          </button>
        </span>
      </header>

      {machine === 'treadmill' ? treadmill() : stair()}

      <footer className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </footer>
    </Modal>
  )

  function directionToggle(forward: string, inverse: string) {
    return (
      <span className="segmented" role="group" aria-label="Direction">
        <button aria-pressed={direction === 'forward'} onClick={() => switchDirection('forward')}>
          {forward}
        </button>
        <button aria-pressed={direction === 'inverse'} onClick={() => switchDirection('inverse')}>
          {inverse}
        </button>
      </span>
    )
  }

  function treadmill() {
    const toFlat = direction === 'forward'
    const speed = parseSpeed(speedText, unit)
    const convert = (kmh: number, g: number) => (toFlat ? gradeAdjustedSpeed(kmh, g) : speedForGap(kmh, g))
    const result = speed && validGrade ? convert(speed, grade) : undefined
    const treadmillSpeed = toFlat ? speed : result
    const both = (kmh: number) => `${fmtSpeedIn(kmh, unit)} (${fmtSpeedIn(kmh, unit === 'pace' ? 'kmh' : 'pace')})`

    return (
      <>
        <div className="calc-controls">
          {directionToggle('Incline → flat', 'Flat → incline')}
          <SpeedUnitToggle value={unit} onChange={setUnit} />
        </div>

        <div className="calc-fields">
          <label className="field">
            <span>
              {toFlat ? 'Treadmill speed' : 'Target flat pace'} ({unit === 'pace' ? 'min/km' : 'km/h'})
            </span>
            <input
              autoFocus
              inputMode="decimal"
              value={speedText}
              onChange={(e) => setSpeedText(e.target.value)}
              placeholder={unit === 'pace' ? '5:30' : '8.5'}
              aria-invalid={speedText.trim() !== '' && !speed}
            />
          </label>
          <label className="field">
            <span>Incline (%)</span>
            <input
              type="number"
              inputMode="decimal"
              step={0.5}
              min={-45}
              max={45}
              value={inclineText}
              onChange={(e) => setInclineText(e.target.value)}
              aria-invalid={!validGrade}
            />
          </label>
        </div>

        <div className="stats-row">
          <div>
            <span className="label">{toFlat ? 'Grade-adjusted pace' : 'Treadmill speed'}</span>
            <span className="value">{result ? both(result) : '—'}</span>
          </div>
          <div>
            <span className="label">Climb rate</span>
            <span className="value">{treadmillSpeed && validGrade ? perHour(climbRate(treadmillSpeed, grade)) : '—'}</span>
          </div>
        </div>

        {speed && (
          <table className="steps calc-table">
            <thead>
              <tr>
                <th>Incline</th>
                <th>{toFlat ? `GAP at ${fmtSpeedIn(speed, unit)}` : `Speed for ${fmtSpeedIn(speed, unit)} flat`}</th>
                <th className="num">Climb</th>
              </tr>
            </thead>
            <tbody>
              {INCLINES.map((i) => {
                const converted = convert(speed, i / 100)
                return (
                  <tr key={i} className={validGrade && Math.abs(grade * 100 - i) < 1e-9 ? 'current' : undefined}>
                    <td>{i}%</td>
                    <td>{fmtSpeedIn(converted, unit)}</td>
                    <td className="num">{perHour(climbRate(toFlat ? speed : converted, i / 100))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <p className="help" style={{ marginTop: 10 }}>
          Uses the Minetti et al. (2002) energy cost of running on a grade. Other models, such as Strava&rsquo;s
          heart-rate-based GAP, can differ noticeably on steep grades.
        </p>
      </>
    )
  }

  function stair() {
    const fromSteps = direction === 'forward'
    const stepHeight = positive(stepHeightText)
    const input = positive(rateText)
    const stepRate = input && stepHeight ? (fromSteps ? input : input / 60 / stepHeight) : undefined
    const climb = stepRate && stepHeight ? stairClimbRate(stepRate, stepHeight) : undefined
    const floorsPerMin = (m: number) => num(m / 60 / settings.stairFloorHeight, 1)
    const gap = climb ? stairGap(climb) : undefined
    // Same energy cost as the stair climber, via its GAP.
    const treadmillFor = (m: number) => (validGrade ? speedForGap(stairGap(m), grade) : undefined)
    const treadmillSpeed = climb ? treadmillFor(climb) : undefined
    const other: SpeedUnit = settings.speedUnit === 'pace' ? 'kmh' : 'pace'

    return (
      <>
        <div className="calc-controls">{directionToggle('Steps → climb', 'Climb → steps')}</div>

        <div className="calc-fields">
          <label className="field">
            <span>{fromSteps ? 'Step rate (spm)' : 'Climb rate (m/h)'}</span>
            <input
              autoFocus
              type="number"
              inputMode="decimal"
              min={0}
              value={rateText}
              onChange={(e) => setRateText(e.target.value)}
              placeholder={fromSteps ? '70' : '850'}
              aria-invalid={rateText.trim() !== '' && !input}
            />
          </label>
          <label className="field">
            <span>Step height (m)</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={stepHeightText}
              onChange={(e) => setStepHeightText(e.target.value)}
              aria-invalid={!stepHeight}
            />
          </label>
          <label className="field">
            <span>Treadmill incline (%)</span>
            <input
              type="number"
              inputMode="decimal"
              step={0.5}
              min={0}
              max={45}
              value={inclineText}
              onChange={(e) => setInclineText(e.target.value)}
              aria-invalid={!validGrade}
            />
          </label>
        </div>

        <div className="stats-row">
          <div>
            <span className="label">{fromSteps ? 'Climb rate' : 'Step rate'}</span>
            <span className="value">
              {climb && stepRate ? (fromSteps ? perHour(climb) : `${num(stepRate, 1)} spm`) : '—'}
            </span>
          </div>
          <div>
            <span className="label">Floors/min</span>
            <span className="value">{climb ? floorsPerMin(climb) : '—'}</span>
          </div>
          <div>
            <span className="label">Grade-adjusted pace</span>
            <span className="value">
              {gap ? `${fmtSpeedIn(gap, settings.speedUnit)} (${fmtSpeedIn(gap, other)})` : '—'}
            </span>
          </div>
          <div>
            <span className="label">Treadmill at {validGrade ? num(grade * 100, 1) : '—'}%</span>
            <span className="value">{treadmillSpeed ? fmtSpeedIn(treadmillSpeed, settings.speedUnit) : '—'}</span>
          </div>
        </div>

        {stepHeight && (
          <table className="steps calc-table">
            <thead>
              <tr>
                <th>spm</th>
                <th className="num">Climb m/h</th>
                <th className="num">Floors/min</th>
                <th className="num">GAP</th>
                <th className="num">Treadmill at {validGrade ? num(grade * 100, 1) : '—'}%</th>
              </tr>
            </thead>
            <tbody>
              {STEP_RATES.map((spm) => {
                const m = stairClimbRate(spm, stepHeight)
                const t = treadmillFor(m)
                return (
                  <tr key={spm} className={stepRate && Math.abs(stepRate - spm) < 1e-9 ? 'current' : undefined}>
                    <td>{spm}</td>
                    <td className="num">{Math.round(m)}</td>
                    <td className="num">{floorsPerMin(m)}</td>
                    <td className="num">{fmtSpeedIn(stairGap(m), settings.speedUnit)}</td>
                    <td className="num">{t ? fmtSpeedIn(t, settings.speedUnit) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <p className="help" style={{ marginTop: 10 }}>
          Climb rate is step rate × step height. Step height starts from Settings; a floor is{' '}
          {num(settings.stairFloorHeight)} m. GAP uses the Minetti et al. (2002) energy cost of running, treating the
          stair climber as a 45% grade, the steepest the model covers; real stairs are steeper, so it&rsquo;s an
          approximation. The treadmill column is the speed with the same energy cost on that incline.
        </p>
      </>
    )
  }
}
