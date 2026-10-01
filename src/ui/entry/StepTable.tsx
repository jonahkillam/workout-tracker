import { useState, type ReactNode } from 'react'
import type { Block, Profile, Repeat, SpeedUnit, Sport, Step, Targets } from '../../model/types'
import { KIND_LABEL, STEP_KINDS } from '../../model/types'
import { insertAt, moveBy, newStep, occurrences, removeAt, replaceAt, type Path } from '../../model/tree'
import { stepStats } from '../../metrics/workout'
import { amountText, fmtDistance, fmtDuration, fmtRange, fmtSpeed, fmtSpeedIn, mid } from '../../parser/format'
import { parseWorkout } from '../../parser/parser'
import { fmtTargets, TARGET_ORDER } from '../../parser/serialize'
import { CommitInput } from '../common/CommitInput'
import { Sheet } from '../common/Sheet'
import { useNarrow } from '../common/useNarrow'

interface Props {
  blocks: Block[]
  onChange: (blocks: Block[]) => void
  sport: Sport
  profile: Profile
  speedUnit: SpeedUnit
  rpe?: number
  /** Recorded average HR per step, from the linked recording. */
  stepHr?: Map<Step, number>
  /** Disables editing, e.g. while the text has errors that a rewrite would lose. */
  readOnly?: boolean
}

const OTHER_KEYS = TARGET_ORDER.filter((k) => k !== 'speed' && k !== 'incline')

/** Parses an amount cell ("40s", "1km", "100fl") into step fields. Every step needs one, so empty is rejected. */
function parseAmount(text: string): Pick<Step, 'duration' | 'distance' | 'floors'> | null {
  if (!text) return null
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

function blockAt(blocks: Block[], path: Path): Block | undefined {
  let list: Block[] | undefined = blocks
  let found: Block | undefined
  for (const i of path) {
    found = list?.[i]
    list = found?.type === 'repeat' ? found.children : undefined
  }
  return found
}

/**
 * The workout as editable rows. At phone width it's a list, one line per step, and a row opens
 * in a sheet with the same fields.
 */
export function StepTable({ blocks, onChange, sport, profile, speedUnit, rpe, stepHr, readOnly }: Props) {
  const narrow = useNarrow()
  // The row open in the sheet, with the blocks as they were for Cancel.
  const [open, setOpen] = useState<{ path: Path; original: Block[] } | null>(null)

  const update = (path: Path, b: Block) => onChange(replaceAt(blocks, path, b))

  const setTargets = (path: Path, step: Step, keys: (keyof Targets)[], parsed: Targets | null) => {
    if (!parsed) return
    const targets = { ...step.targets }
    for (const k of keys) delete targets[k]
    update(path, { ...step, targets: { ...targets, ...parsed } })
  }

  const actions = (path: Path, extra?: ReactNode) => (
    <>
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
    </>
  )
  const addInside = (p: Path, b: Repeat) => (
    <button
      title="Add a step inside this repeat"
      onClick={() => onChange(insertAt(blocks, [...p, b.children.length], newStep('work', 60)))}
    >
      + step
    </button>
  )

  // The fields of a row, shared by the table and the sheet.
  const countField = (p: Path, b: Repeat) => (
    <CommitInput
      aria-label="Repeat count"
      inputMode="numeric"
      value={String(b.count)}
      onCommit={(v) => {
        const n = parseInt(v, 10)
        if (n > 0) update(p, { ...b, count: n })
      }}
    />
  )
  const skipField = (p: Path, b: Repeat) => (
    <label className="check">
      <input
        type="checkbox"
        checked={!!b.skipLastRest}
        onChange={(e) => update(p, { ...b, skipLastRest: e.target.checked || undefined })}
      />
      drop final rest
    </label>
  )
  const kindField = (p: Path, b: Step) => (
    <select aria-label="Step kind" value={b.kind} onChange={(e) => update(p, { ...b, kind: e.target.value as Step['kind'] })}>
      {STEP_KINDS.map((k) => (
        <option key={k} value={k}>
          {KIND_LABEL[k]}
        </option>
      ))}
    </select>
  )
  const amountField = (p: Path, b: Step) => (
    <CommitInput
      aria-label="Duration or distance"
      value={amountText(b)}
      placeholder="10m / 1km"
      onCommit={(v) => {
        const a = parseAmount(v)
        if (a) update(p, { ...b, ...a })
      }}
    />
  )
  const speedField = (p: Path, b: Step) => (
    <CommitInput
      aria-label="Speed or pace"
      value={b.targets.speed ? fmtSpeed(b.targets.speed, speedUnit === 'pace') : ''}
      placeholder={speedUnit === 'pace' ? 'min/km' : 'km/h'}
      onCommit={(v) => setTargets(p, b, ['speed', 'asPace'], v ? parseTargets(v, speedUnit) : {})}
    />
  )
  const inclineField = (p: Path, b: Step) => (
    <CommitInput
      aria-label="Incline"
      value={b.targets.incline ? fmtRange(b.targets.incline, '%') : ''}
      placeholder="%"
      onCommit={(v) => setTargets(p, b, ['incline'], v ? parseTargets(v, speedUnit, '%') : {})}
    />
  )
  const otherField = (p: Path, b: Step) => (
    <CommitInput
      aria-label="Other targets"
      value={fmtTargets(b.targets, OTHER_KEYS)}
      placeholder="e.g. Z3, rpe7"
      onCommit={(v) => setTargets(p, b, OTHER_KEYS, v ? parseTargets(v, speedUnit) : {})}
    />
  )

  const counts = occurrences(blocks)
  const computedText = (b: Step) => {
    const s = stepStats(b, sport, profile, rpe)
    const t = b.targets
    const n = counts.get(b) ?? 0
    return [
      b.duration === undefined && s.duration ? fmtDuration(s.duration) : '',
      b.distance === undefined && s.distance ? fmtDistance(Math.round(s.distance)) : '',
      s.vertical ? `+${Math.round(s.vertical)}m` : '',
      s.gapSpeed && t.incline && mid(t.incline) ? `GAP ${fmtSpeedIn(s.gapSpeed, speedUnit)}` : '',
      b.kind === 'pause' ? 'not counted' : `Z${s.zone}`,
      n !== 1 ? `×${n}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const rows: ReactNode[] = []
  const visit = (list: Block[], path: Path, depth: number) => {
    list.forEach((b, i) => {
      const p = [...path, i]
      const key = p.join('.')
      const indent = { paddingLeft: depth * 18 }
      if (narrow) {
        const hr = b.type === 'step' && stepHr?.has(b) ? ` · ${Math.round(stepHr.get(b)!)} bpm` : ''
        rows.push(
          <div key={key} className={b.type === 'repeat' ? 'step-row repeat-row' : 'step-row'} style={indent}>
            <button type="button" className="step-open" onClick={() => setOpen({ path: p, original: blocks })}>
              {b.type === 'repeat' ? (
                <span>
                  {b.count} × repeat{b.skipLastRest ? ' · drop final rest' : ''}
                </span>
              ) : (
                <>
                  <span>
                    <strong>{KIND_LABEL[b.kind]}</strong> {[amountText(b), fmtTargets(b.targets)].filter(Boolean).join(' · ')}
                  </span>
                  <span className="computed">
                    {computedText(b)}
                    {hr}
                  </span>
                </>
              )}
            </button>
            <span className="row-actions">{actions(p)}</span>
          </div>,
        )
        if (b.type === 'repeat') visit(b.children, p, depth + 1)
        return
      }
      if (b.type === 'repeat') {
        rows.push(
          <tr key={key} className="repeat-row">
            <td colSpan={2} style={indent}>
              <div className="repeat-head">
                <div style={{ width: 52 }}>{countField(p, b)}</div>
                <span>× repeat</span>
              </div>
            </td>
            <td colSpan={4}>{skipField(p, b)}</td>
            <td />
            <td className="row-actions">{actions(p, addInside(p, b))}</td>
          </tr>,
        )
        visit(b.children, p, depth + 1)
        return
      }

      rows.push(
        <tr key={key}>
          <td style={indent}>{kindField(p, b)}</td>
          <td>{amountField(p, b)}</td>
          <td>{speedField(p, b)}</td>
          <td>{inclineField(p, b)}</td>
          <td>{otherField(p, b)}</td>
          <td className="computed">{stepHr?.has(b) ? Math.round(stepHr.get(b)!) : ''}</td>
          <td className="computed">{computedText(b)}</td>
          <td className="row-actions">{actions(p)}</td>
        </tr>,
      )
    })
  }
  visit(blocks, [], 0)

  const addRepeat = () => {
    const r: Repeat = { type: 'repeat', count: 4, children: [newStep('work', 60), newStep('rest', 60)] }
    onChange([...blocks, r])
  }
  const builder = (
    <div className="builder">
      <button onClick={() => onChange([...blocks, newStep('wu', 600)])}>+ Warm-up</button>
      <button onClick={() => onChange([...blocks, newStep('steady', 600)])}>+ Step</button>
      <button onClick={addRepeat}>+ Repeat</button>
      <button onClick={() => onChange([...blocks, newStep('cd', 600)])}>+ Cool-down</button>
    </div>
  )

  if (narrow) {
    const b = open && !readOnly ? blockAt(blocks, open.path) : undefined
    const close = () => setOpen(null)
    const field = (label: string, input: ReactNode) => (
      <label className="field">
        <span>{label}</span>
        {input}
      </label>
    )
    return (
      <fieldset className="step-table" disabled={readOnly}>
        {rows.length > 0 && <div className="step-rows">{rows}</div>}
        {builder}
        {open && b && (
          <Sheet
            title={b.type === 'repeat' ? 'Repeat' : KIND_LABEL[b.kind]}
            onDone={close}
            onCancel={() => {
              if (blocks !== open.original) onChange(open.original)
              close()
            }}
          >
            {b.type === 'repeat' ? (
              <>
                {field('Times', countField(open.path, b))}
                {skipField(open.path, b)}
              </>
            ) : (
              <>
                {field('Step', kindField(open.path, b))}
                {field('Amount', amountField(open.path, b))}
                {field(speedUnit === 'pace' ? 'Pace' : 'Speed', speedField(open.path, b))}
                {field('Incline', inclineField(open.path, b))}
                {field('Other targets', otherField(open.path, b))}
                <p className="meta">{computedText(b)}</p>
              </>
            )}
            <div className="sheet-actions">
              {b.type === 'repeat' && addInside(open.path, b)}
              <button
                type="button"
                className="danger"
                onClick={() => {
                  onChange(removeAt(blocks, open.path))
                  close()
                }}
              >
                Delete
              </button>
            </div>
          </Sheet>
        )}
      </fieldset>
    )
  }

  return (
    <fieldset className="step-table" disabled={readOnly}>
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
      {builder}
    </fieldset>
  )
}
