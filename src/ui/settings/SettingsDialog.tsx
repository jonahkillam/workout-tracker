import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { signOut } from '../../auth/session'
import { db, exportAll, importAll, saveSettings, type ExportFile } from '../../db/db'
import { today } from '../../metrics/dates'
import type { Settings, SpeedUnit } from '../../model/types'
import { fmtPace } from '../../parser/format'
import { connectUrl, disconnectStrava, stravaConfigured } from '../../strava/auth'
import { useSyncStatus } from '../../sync/useSyncStatus'
import { supabase } from '../../supabase'
import { Modal } from '../common/Modal'
import { ThresholdFields } from '../common/ThresholdFields'

interface Props {
  settings: Settings
  onClose: () => void
}

/** A stair height from its field: empty is NaN, so it shows as empty and fails the check below. */
const height = (v: string) => (v.trim() ? Number(v) : NaN)
const validHeight = (m: number) => m > 0

export function SettingsDialog({ settings, onClose }: Props) {
  const [s, setS] = useState(settings)
  const [paceText, setPaceText] = useState(settings.thresholdSpeed ? fmtPace(settings.thresholdSpeed) : '')
  const [message, setMessage] = useState('')
  const paceInvalid = paceText.trim() !== '' && s.thresholdSpeed === undefined
  const heightsInvalid = !validHeight(s.stairStepHeight) || !validHeight(s.stairFloorHeight)

  const download = async () => saveFile(await exportAll())

  const upload = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    // Cleared so picking the same file again still fires a change.
    input.value = ''
    if (!file) return
    try {
      await importAll(JSON.parse(await file.text()))
      setMessage(`Imported ${file.name}.`)
    } catch (e) {
      setMessage(`Import failed: ${(e as Error).message}`)
    }
  }

  return (
    <Modal label="Settings" onClose={onClose}>
      <header className="modal-head">
        <h2>Settings</h2>
      </header>

      <h3>Thresholds</h3>
      <p className="help">
        Copied onto each new workout, so changing them later doesn&rsquo;t alter past zones. Workouts that have no
        value recorded take the one you set here.
      </p>
      <div className="form-grid">
        <ThresholdFields
          profile={s}
          paceText={paceText}
          hints
          onChange={(p, t) => {
            setS({ ...s, ...p })
            setPaceText(t)
          }}
        />
      </div>

      <h3>Equipment</h3>
      <div className="form-grid">
        <label className="field">
          <span>Stair step height (m)</span>
          <input
            type="number"
            step="any"
            min={0}
            value={Number.isNaN(s.stairStepHeight) ? '' : s.stairStepHeight}
            aria-invalid={!validHeight(s.stairStepHeight)}
            onChange={(e) => setS({ ...s, stairStepHeight: height(e.target.value) })}
          />
          {validHeight(s.stairStepHeight) ? (
            <small>Climb per step, used with spm</small>
          ) : (
            <small className="warn">Must be more than 0</small>
          )}
        </label>
        <label className="field">
          <span>Stair floor height (m)</span>
          <input
            type="number"
            step={0.05}
            min={0}
            value={Number.isNaN(s.stairFloorHeight) ? '' : s.stairFloorHeight}
            aria-invalid={!validHeight(s.stairFloorHeight)}
            onChange={(e) => setS({ ...s, stairFloorHeight: height(e.target.value) })}
          />
          {validHeight(s.stairFloorHeight) ? (
            <small>Climb per floor, used with fl</small>
          ) : (
            <small className="warn">Must be more than 0</small>
          )}
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

      <h3>Account</h3>
      <AccountSection onSignedOut={onClose} />

      <h3>Data</h3>
      <p className="help">Saved to your account, with a copy in this browser for working offline.</p>
      <div className="form-row">
        <button onClick={download}>Export JSON</button>
        <label className="button">
          Import JSON…
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => upload(e.target)}
          />
        </label>
      </div>
      {message && <p className="help">{message}</p>}

      <footer className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={paceInvalid || heightsInvalid}
          title={paceInvalid || heightsInvalid ? 'Fix the fields marked in red first' : undefined}
          onClick={async () => {
            await saveSettings(s)
            onClose()
          }}
        >
          Save
        </button>
      </footer>
    </Modal>
  )
}

function StravaSection() {
  const auth = useLiveQuery(async () => (await db.stravaConnection.get('strava')) ?? null, [])
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

/** Downloads the export, named with today's local date. */
function saveFile(data: ExportFile) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `training-log-${today()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function AccountSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [email, setEmail] = useState<string>()
  const status = useSyncStatus()
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email))
  }, [])
  return (
    <div className="form-row">
      <span>
        Signed in as <strong>{email}</strong>
      </span>
      <span className="help" style={{ margin: 0 }}>
        {status.pending ? `${status.pending} change${status.pending === 1 ? '' : 's'} not yet saved` : 'All changes saved'}
        {status.error && ` (last attempt failed: ${status.error})`}
      </span>
      <button
        onClick={async () => {
          if (await signOut()) onSignedOut()
        }}
      >
        Sign out
      </button>
    </div>
  )
}
