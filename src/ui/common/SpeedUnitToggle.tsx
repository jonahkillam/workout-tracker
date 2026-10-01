import type { SpeedUnit } from '../../model/types'

/** km/h or min/km. */
export function SpeedUnitToggle({ value, onChange }: { value: SpeedUnit; onChange: (u: SpeedUnit) => void }) {
  return (
    <span className="segmented" role="group" aria-label="Speed unit">
      {(['kmh', 'pace'] as const).map((u) => (
        <button key={u} type="button" aria-pressed={value === u} onClick={() => onChange(u)}>
          {u === 'kmh' ? 'km/h' : 'min/km'}
        </button>
      ))}
    </span>
  )
}
