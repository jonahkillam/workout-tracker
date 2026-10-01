import type { Profile } from '../../model/types'
import { num, parsePaceInput } from '../../parser/format'

const optionalNumber = (v: string) => (v.trim() ? Number(v) : undefined)

interface Props {
  profile: Profile
  /** The threshold pace as typed, kept separately so a half-typed pace isn't lost. */
  paceText: string
  onChange: (profile: Profile, paceText: string) => void
  /** Show a hint under each field. */
  hints?: boolean
}

/** Threshold pace, FTP, threshold HR and max HR, for Settings and for one workout. Bare fields, for the caller's layout. */
export function ThresholdFields({ profile: p, paceText, onChange, hints }: Props) {
  const invalid = paceText.trim() !== '' && p.thresholdSpeed === undefined
  const numberField = (key: 'ftp' | 'lthr' | 'maxHr', label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={p[key] ?? ''}
        onChange={(e) => onChange({ ...p, [key]: optionalNumber(e.target.value) }, paceText)}
      />
      {hints && <small>{hint}</small>}
    </label>
  )
  return (
    <>
      <label className="field">
        <span>Threshold pace (min/km)</span>
        <input
          value={paceText}
          placeholder="e.g. 4:15"
          aria-invalid={invalid}
          onChange={(e) => onChange({ ...p, thresholdSpeed: parsePaceInput(e.target.value) }, e.target.value)}
        />
        {(hints || invalid) && (
          <small className={invalid ? 'warn' : undefined}>
            {invalid
              ? 'Use m:ss, e.g. 4:15'
              : p.thresholdSpeed
                ? `${num(p.thresholdSpeed, 1)} km/h on the flat; sets pace zones`
                : 'Flat-road pace you could hold for about an hour'}
          </small>
        )}
      </label>
      {numberField('ftp', 'FTP (W)', 'Sets power zones')}
      {numberField('lthr', 'Threshold heart rate', 'Sets heart-rate zones')}
      {numberField('maxHr', 'Max heart rate', 'Recorded for reference')}
    </>
  )
}
