import { useState, type ReactNode } from 'react'
import type { Block, Profile, Repeat, SpeedUnit, Sport, Step, Targets } from '../../model/types'
import { KIND_LABEL, STEP_KINDS } from '../../model/types'
import { insertAt, moveBy, newStep, occurrences, removeAt, replaceAt, type Path } from '../../model/tree'
import { stepStats } from '../../metrics/workout'
import { amountText, fmtDistance, fmtDuration, fmtRange, fmtSpeed, fmtSpeedIn, mid } from '../../parser/format'
import { parseWorkout } from '../../parser/parser'
import { fmtTarget, TARGET_ORDER } from '../../parser/serialize'

interface Props {
  blocks: Block[]
  onChange: (blocks: Block[]) => void
  sport: Sport
  profile: Profile
  speedUnit: SpeedUnit
  rpe?: number
  /** Recorded average HR per step, from the linked recording. */
  stepHr?: Map<Step, number>
}

const OTHER_KEYS = TARGET_ORDER.filter((k) => k !== 'speed' && k !== 'incline')

/** Text input that commits on blur or Enter and resets if the value changes underneath. */
function Cell({ value, onCommit, placeholder, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <input
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

/** Parses an amount cell ("40s", "1km", "100fl") into step fields. */
function parseAmount(text: string): Pick<Step, 'duration' | 'distance' | 'floors'> | null {
  if (!text) return { duration: undefined, distance: undefined, floors: undefined }
  const [b] = parseWorkout(text).blocks
  if (b?.type !== 'step') return null
  return { duration: b.duration, distance: b.distance, floors: b.floors }
}

/** Parses target text ("15", "8.3-8.8", "4:30", "Z4, 220w") via the shorthand parser. */
function parseTargets(text: string, speedUnit: SpeedUnit, defaultUnit = ''): Targets | null {
  const withUnit = defaultUnit && /^[\d.\s-]+$/.test(text) ? `${text}${defaultUnit}` : text
  const r = parseWorkout(`1s @ ${withUnit}`, { speedUnit })
  if (r.diagnostics.some((d) => d.severity === 'error')) return null
  const [b] = r.blocks
  return b?.type === 'step' ? b.targets : null
}

export function StepTable({ blocks, onChange, sport, profile, speedUnit, rpe, stepHr }: Props) {
  const update = (path: Path, b: Block) => onChange(replaceAt(blocks, path, b))

  const setTargets = (path: Path, step: Step, keys: (keyof Targets)[], parsed: Targets | null) => {
    if (!parsed) return
    const targets = { ...step.targets }
    for (const k of keys) delete targets[k]
    update(path, { ...step, targets: { ...targets, ...parsed } })
  }

  const actions = (path: Path, extra?: ReactNode) => (
    <td className="row-actions">
      {extra}
      <button className="icon" title="Move up" onClick={() => onChange(moveBy(blocks, path, -1))}>
        ↑
      </button>
      <button className="icon" title="Move down" onClick={() => onChange(moveBy(blocks, path, 1))}>
        ↓
      </button>
      <button className="icon danger" title="Delete" onClick={() => onChange(removeAt(blocks, path))}>
        ✕
      </button>
    </td>
  )

  const counts = occurrences(blocks)
  const rows: ReactNode[] = []
  const visit = (list: Block[], path: Path, depth: number) => {
    list.forEach((b, i) => {
      const p = [...path, i]
      const indent = { paddingLeft: depth * 18 }
      if (b.type === 'repeat') {
        rows.push(
          <tr key={p.join('.')} className="repeat-row">
            <td colSpan={2} style={indent}>
              <div className="repeat-head">
                <div style={{ width: 52 }}>
                  <Cell
                    label="Repeat count"
                    value={String(b.count)}
                    onCommit={(v) => {
                      const n = parseInt(v, 10)
                      if (n > 0) update(p, { ...b, count: n })
                    }}
                  />
                </div>
                <span>× repeat</span>
              </div>
            </td>
            <td colSpan={4}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!b.skipLastRest}
                  onChange={(e) => update(p, { ...b, skipLastRest: e.target.checked || undefined })}
                />
                drop final rest
              </label>
            </td>
            <td />
            {actions(
              p,
              <button
                title="Add a step inside this repeat"
                onClick={() => onChange(insertAt(blocks, [...p, b.children.length], newStep('work', 60)))}
              >
                + step
              </button>,
            )}
          </tr>,
        )
        visit(b.children, p, depth + 1)
        return
      }

      const s = stepStats(b, sport, profile, rpe)
      const t = b.targets
      const other = OTHER_KEYS.map((k) => fmtTarget(k, t)).filter(Boolean).join(', ')
      const computed = [
        b.duration === undefined && s.duration ? fmtDuration(s.duration) : '',
        b.distance === undefined && s.distance ? fmtDistance(Math.round(s.distance)) : '',
        s.vertical ? `+${Math.round(s.vertical)}m` : '',
        s.gapSpeed && t.incline && mid(t.incline) ? `GAP ${fmtSpeedIn(s.gapSpeed, speedUnit)}` : '',
        b.kind === 'pause' ? 'not counted' : `Z${s.zone}`,
      ]
        .filter(Boolean)
        .join(' · ')
      rows.push(
        <tr key={p.join('.')}>
          <td style={indent}>
            <select
              aria-label="Step kind"
              value={b.kind}
              onChange={(e) => update(p, { ...b, kind: e.target.value as Step['kind'] })}
            >
              {STEP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </td>
          <td>
            <Cell
              label="Duration or distance"
              value={amountText(b)}
              placeholder="10m / 1km"
              onCommit={(v) => {
                const a = parseAmount(v)
                if (a) update(p, { ...b, ...a })
              }}
            />
          </td>
          <td>
            <Cell
              label="Speed or pace"
              value={t.speed ? fmtSpeed(t.speed, speedUnit === 'pace') : ''}
              placeholder={speedUnit === 'pace' ? 'min/km' : 'km/h'}
              onCommit={(v) => setTargets(p, b, ['speed', 'asPace'], v ? parseTargets(v, speedUnit) : {})}
            />
          </td>
          <td>
            <Cell
              label="Incline"
              value={t.incline ? fmtRange(t.incline, '%') : ''}
              placeholder="%"
              onCommit={(v) => setTargets(p, b, ['incline'], v ? parseTargets(v, speedUnit, '%') : {})}
            />
          </td>
          <td>
            <Cell
              label="Other targets"
              value={other}
              placeholder="e.g. Z3, rpe7"
              onCommit={(v) => setTargets(p, b, OTHER_KEYS, v ? parseTargets(v, speedUnit) : {})}
            />
          </td>
          <td className="computed">{stepHr?.has(b) ? Math.round(stepHr.get(b)!) : ''}</td>
          <td className="computed">
            {computed}
            {(counts.get(b) ?? 0) !== 1 ? ` · ×${counts.get(b) ?? 0}` : ''}
          </td>
          {actions(p)}
        </tr>,
      )
    })
  }
  visit(blocks, [], 0)

  const addRepeat = () => {
    const r: Repeat = { type: 'repeat', count: 4, children: [newStep('work', 60), newStep('rest', 60)] }
    onChange([...blocks, r])
  }

  return (
    <div>
      {blocks.length > 0 && (
        <table className="steps">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Step</th>
              <th style={{ width: 100 }}>Amount</th>
              <th style={{ width: 130 }}>{speedUnit === 'pace' ? 'Pace' : 'Speed'}</th>
              <th style={{ width: 80 }}>Incline</th>
              <th>Other</th>
              <th style={{ width: stepHr ? 40 : 0 }}>{stepHr ? 'HR' : ''}</th>
              <th>Computed</th>
              <th />
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      )}
      <div className="builder">
        <button onClick={() => onChange([...blocks, newStep('wu', 600)])}>+ Warm-up</button>
        <button onClick={() => onChange([...blocks, newStep('steady', 600)])}>+ Step</button>
        <button onClick={addRepeat}>+ Repeat</button>
        <button onClick={() => onChange([...blocks, newStep('cd', 600)])}>+ Cool-down</button>
      </div>
    </div>
  )
}
