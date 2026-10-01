import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SpeedUnit } from '../../model/types'
import type { Diagnostic, Highlight } from '../../parser/parser'
import { Sheet } from '../common/Sheet'
import { SpeedUnitToggle } from '../common/SpeedUnitToggle'
import { useNarrow } from '../common/useNarrow'

interface Props {
  value: string
  onChange: (v: string) => void
  highlights: Highlight[]
  diagnostics: Diagnostic[]
  speedUnit: SpeedUnit
  onSpeedUnit: (u: SpeedUnit) => void
  autoFocus?: boolean
}

const PLACEHOLDER: Record<SpeedUnit, string> = {
  kmh: '10m wu, 3x10x40/20 @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd',
  pace: '15m easy @ 5:45/km, 5x1km/2m @ 4:05-4:10/km, 10m cd',
}

/** Characters the shorthand leans on that sit behind a phone keyboard's symbol layers. */
const SYMBOLS = ['x', '/', '//', '@', '%', ':', '-', '(', ')', ',']

/**
 * Textarea with live token highlighting, drawn by a mirror element behind it. At phone width the text
 * is shown read-only and opens in a sheet to edit, with a row of buttons for the shorthand's symbols.
 */
export function ShorthandInput({ value, onChange, highlights, diagnostics, speedUnit, onSpeedUnit, autoFocus }: Props) {
  const mirror = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const narrow = useNarrow()
  // The text as it was when the sheet opened, for Cancel.
  const [opened, setOpened] = useState<string | null>(null)

  // Where to put the caret once an inserted symbol has rendered; a controlled textarea sends it to the end.
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caret.current === null) return
    area.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [value])
  const insert = (text: string) => {
    const el = area.current
    if (!el) return
    caret.current = el.selectionStart + text.length
    onChange(value.slice(0, el.selectionStart) + text + value.slice(el.selectionEnd))
  }

  const classes: (string | undefined)[] = new Array(value.length)
  for (const h of highlights) for (let i = h.start; i < h.end; i++) classes[i] = `hl-${h.cls}`
  for (const d of diagnostics) for (let i = d.start; i < d.end; i++) classes[i] = `hl-${d.severity}`

  const parts: ReactNode[] = []
  let runStart = 0
  for (let i = 1; i <= value.length; i++) {
    if (i === value.length || classes[i] !== classes[runStart]) {
      const text = value.slice(runStart, i)
      parts.push(classes[runStart] ? <span key={runStart} className={classes[runStart]}>{text}</span> : text)
      runStart = i
    }
  }

  const field = (focus?: boolean) => (
    <div className="shorthand">
      <div className="mirror" ref={mirror} aria-hidden>
        {parts}
        {'\n'}
      </div>
      <textarea
        ref={area}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus={focus}
        placeholder={PLACEHOLDER[speedUnit]}
        id="shorthand"
        aria-label="Workout shorthand"
      />
    </div>
  )
  const problems = diagnostics.length > 0 && (
    <ul className="diagnostics">
      {diagnostics.map((d, i) => (
        <li key={i} className={d.severity}>
          <code>{value.slice(d.start, d.end)}</code> {d.message}
        </li>
      ))}
    </ul>
  )
  const syntax = (
      <details className="syntax-help">
        <summary>Syntax</summary>
        <p>
          Separate steps with commas or new lines. Durations <code>10m</code> <code>40s</code> <code>1h5m</code>;
          distances <code>2km</code> <code>800mtr</code> <code>1mi</code>; stairs <code>100fl</code>. Roles{' '}
          <code>wu</code> <code>cd</code> <code>easy</code> <code>work</code> <code>rec</code>.
        </p>
        <p>
          Repeats: <code>5x3m/2m</code> is work/rest; <code>3x10x40/20</code> is sets × reps (bare numbers are
          seconds); <code>6x800mtr w/ 90s</code>; <code>3x(…) r3m</code> rests after each set. Add <code>-r</code> to a repeat to drop
          its final recovery: <code>5x3m/2m -r</code>; <code>3x(10x40/20 -r, 5m easy) -r</code> drops the last 20s of
          each set and the last 5m. Inside <code>(…)</code>, steps without a role are work except the
          last, which is the rest: <code>10x(40s @ 8.5km/h, 20s @ 6.7km/h)</code>.
        </p>
        <p>
          Targets follow <code>@</code>: incline <code>15%</code>, speed <code>8.5km/h</code> or pace{' '}
          <code>4:30/km</code>, <code>220w</code>, <code>150bpm</code>, <code>Z3</code>, <code>rpe7</code>,{' '}
          <code>70spm</code>, <code>lvl8</code>. A speed without a unit is read as{' '}
          {speedUnit === 'kmh' ? 'km/h' : 'min/km'}, and <code>4:30</code> is always a pace. Ranges:{' '}
          <code>8.3-8.8km/h</code>. Split work and rest with <code>//</code>: <code>8.5//6.5km/h</code>,{' '}
          <code>15%//5%</code>. Written once, incline and level apply to both; intensity targets apply to the work
          only.
        </p>
      </details>
  )

  if (narrow) {
    return (
      <div>
        <div className="shorthand-bar">
          <label>Workout</label>
          <SpeedUnitToggle value={speedUnit} onChange={onSpeedUnit} />
        </div>
        <button type="button" className="tap-field shorthand-view" aria-label="Edit workout shorthand" onClick={() => setOpened(value)}>
          {value ? parts : <span className="empty">{PLACEHOLDER[speedUnit]}</span>}
        </button>
        {problems}
        {opened !== null && (
          <Sheet
            title="Workout"
            onDone={() => setOpened(null)}
            onCancel={() => {
              if (value !== opened) onChange(opened)
              setOpened(null)
            }}
          >
            <div className="symbols">
              {[...SYMBOLS, speedUnit === 'pace' ? '/km' : 'km/h'].map((sym) => (
                // Keeping the default off mousedown leaves the focus, and the keyboard, with the textarea.
                <button key={sym} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(sym)}>
                  {sym}
                </button>
              ))}
            </div>
            {field(true)}
            {problems}
            <div className="shorthand-bar">
              <label>Speeds without a unit</label>
              <SpeedUnitToggle value={speedUnit} onChange={onSpeedUnit} />
            </div>
            {syntax}
          </Sheet>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="shorthand-bar">
        <label htmlFor="shorthand">Workout</label>
        <SpeedUnitToggle value={speedUnit} onChange={onSpeedUnit} />
      </div>
      {field(autoFocus)}
      {problems}
      {syntax}
    </div>
  )
}
