import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, exportAll, importAll, saveSettings } from '../../db/db'
import type { Settings, SpeedUnit } from '../../model/types'
import { fmtPace, num, parsePaceInput } from '../../parser/format'
import { reprocessAll } from '../../recordings/autolog'
import { connectUrl, disconnectStrava, stravaConfigured } from '../../strava/auth'

interface Props {
  settings: Settings
  onClose: () => void
}

const optionalNumber = (v: string) => (v.trim() ? Number(v) : undefined)

export function SettingsDialog({ settings, onClose }: Props) {
  const [s, setS] = useState(settings)
  const [paceText, setPaceText] = useState(settings.thresholdSpeed ? fmtPace(settings.thresholdSpeed) : '')
  const [message, setMessage] = useState('')
  const paceInvalid = paceText.trim() !== '' && s.thresholdSpeed === undefined

  const download = async () => {
    const data = await exportAll()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `training-log-${data.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const upload = async (file: File) => {
    try {
      await importAll(JSON.parse(await file.text()))
      setMessage(`Imported ${file.name}.`)
    } catch (e) {
      setMessage(`Import failed: ${(e as Error).message}`)
    }
  }

  const numberField = (key: 'ftp' | 'lthr' | 'maxHr', label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={s[key] ?? ''} onChange={(e) => setS({ ...s, [key]: optionalNumber(e.target.value) })} />
      <small>{hint}</small>
    </label>
  )

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="modal-head">
          <h2>Settings</h2>
        </header>

        <h3>Thresholds</h3>
        <p className="help">
          Copied onto each new workout, so changing them later doesn&rsquo;t alter past zones. Workouts that have no
          value recorded take the one you set here.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>Threshold pace (min/km)</span>
            <input
              value={paceText}
              placeholder="e.g. 4:15"
              aria-invalid={paceInvalid}
              onChange={(e) => {
                setPaceText(e.target.value)
                setS({ ...s, thresholdSpeed: parsePaceInput(e.target.value) })
              }}
            />
            <small className={paceInvalid ? 'warn' : undefined}>
              {paceInvalid
                ? 'Use m:ss, e.g. 4:15'
                : s.thresholdSpeed
                  ? `${num(s.thresholdSpeed, 1)} km/h on the flat; sets pace zones`
                  : 'Flat-road pace you could hold for about an hour'}
            </small>
          </label>
          {numberField('ftp', 'FTP (W)', 'Sets power zones')}
          {numberField('lthr', 'Threshold heart rate', 'Sets heart-rate zones')}
          {numberField('maxHr', 'Max heart rate', 'Recorded for reference')}
        </div>

        <h3>Equipment</h3>
        <div className="form-grid">
          <label className="field">
            <span>Stair step height (m)</span>
            <input
              type="number"
              step="any"
              value={s.stairStepHeight}
              onChange={(e) => setS({ ...s, stairStepHeight: Number(e.target.value) })}
            />
            <small>Climb per step, used with spm</small>
          </label>
          <label className="field">
            <span>Stair floor height (m)</span>
            <input
              type="number"
              step={0.05}
              value={s.stairFloorHeight}
              onChange={(e) => setS({ ...s, stairFloorHeight: Number(e.target.value) })}
            />
            <small>Climb per floor, used with fl</small>
          </label>
          <label className="field">
            <span>Default speed unit</span>
            <select value={s.speedUnit} onChange={(e) => setS({ ...s, speedUnit: e.target.value as SpeedUnit })}>
              <option value="kmh">km/h</option>
              <option value="pace">min/km</option>
            </select>
            <small>For new workouts; each can switch</small>
          </label>
        </div>

        <h3>Strava</h3>
        <StravaSection />
        <ReprocessRow />

        <h3>Data</h3>
        <p className="help">Stored in this browser only. Export regularly as a backup.</p>
        <div className="form-row">
          <button onClick={download}>Export JSON</button>
          <label className="button">
            Import JSON…
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        </div>
        {message && <p className="help">{message}</p>}

        <footer className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={paceInvalid}
            onClick={async () => {
              await saveSettings(s)
              onClose()
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}

function StravaSection() {
  const auth = useLiveQuery(async () => (await db.stravaAuth.get('strava')) ?? null, [])
  if (auth === undefined) return null
  if (!stravaConfigured()) {
    return (
      <p className="help">
        Not set up. Create an API app at strava.com/settings/api, copy <code>.env.example</code> to{' '}
        <code>.env.local</code>, fill in the client ID and secret, and restart the dev server.
      </p>
    )
  }
  if (!auth) {
    return (
      <div className="form-row">
        <button onClick={() => (window.location.href = connectUrl())}>Connect Strava</button>
        <span className="help" style={{ margin: 0 }}>
          Pulls each week&rsquo;s activities when you view it, and links them to your workouts.
        </span>
      </div>
    )
  }
  return (
    <div className="form-row">
      <span>
        Connected as <strong>{auth.athleteName || `athlete ${auth.athleteId}`}</strong>
      </span>
      <button
        onClick={async () => {
          if (confirm('Disconnect Strava? Activities already pulled stay in your log.')) await disconnectStrava()
        }}
      >
        Disconnect
      </button>
    </div>
  )
}

/** Re-runs interval detection on generated workouts, to see how detection changes behave. */
function ReprocessRow() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const count = useLiveQuery(() => db.recordings.count(), [])
  if (!count) return null
  const run = async () => {
    setBusy(true)
    try {
      const r = await reprocessAll()
      setResult(`Updated ${r.updated}, created ${r.created}, removed ${r.removed} (now unstructured).`)
    } catch (e) {
      setResult(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="form-row">
      <button onClick={run} disabled={busy}>
        {busy ? 'Reprocessing…' : 'Reprocess logged activities'}
      </button>
      <span className="help" style={{ margin: 0 }}>
        {result || 'Re-detects intervals for runs and rides logged automatically. Workouts you edited are left alone.'}
      </span>
    </div>
  )
}
