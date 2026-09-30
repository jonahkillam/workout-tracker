import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { signOut } from '../../auth/session'
import { db, exportAll, importAll, saveSettings, type ExportFile } from '../../db/db'
import { deleteLegacy, exportLegacy, hasLegacyData } from '../../db/legacy'
import type { Settings, SpeedUnit } from '../../model/types'
import { fmtPace, num, parsePaceInput } from '../../parser/format'
import { reprocessAll } from '../../recordings/autolog'
import { connectUrl, disconnectStrava, stravaConfigured } from '../../strava/auth'
import { useSyncStatus } from '../../sync/useSyncStatus'
import { supabase } from '../../supabase'

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

  const download = async () => saveFile(await exportAll())

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
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        </div>
        {message && <p className="help">{message}</p>}
        <LegacyRow />

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

function saveFile(data: ExportFile, name = `training-log-${data.exportedAt.slice(0, 10)}.json`) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
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

/** Data from before accounts, still in this browser under the old database. */
function LegacyRow() {
  const [present, setPresent] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    void hasLegacyData().then(setPresent)
  }, [])
  if (!present) return message ? <p className="help">{message}</p> : null
  const run = (f: () => Promise<string>) => () =>
    f().then(setMessage, (e: Error) => setMessage(`Failed: ${e.message}`))
  return (
    <>
      <p className="help">
        This browser still has data from before sign-in. It isn&rsquo;t part of your account. Download it as a backup,
        add it to your account, or delete it.
      </p>
      <div className="form-row">
        <button onClick={run(async () => (saveFile(await exportLegacy(), 'training-log-before-sign-in.json'), 'Downloaded.'))}>
          Download backup
        </button>
        <button onClick={run(async () => (await importAll(await exportLegacy()), 'Added to your account.'))}>
          Add to account
        </button>
        <button
          className="danger"
          onClick={run(async () => {
            if (!confirm('Delete the data from before sign-in? Download a backup first if you might need it.')) return ''
            await deleteLegacy()
            setPresent(false)
            return 'Deleted.'
          })}
        >
          Delete
        </button>
      </div>
      {message && <p className="help">{message}</p>}
    </>
  )
}
