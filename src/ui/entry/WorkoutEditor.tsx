import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db, deleteWorkout, saveWorkout } from '../../db/db'
import { fmtLongDate } from '../../metrics/dates'
import { needsThresholdPace, workoutTotals } from '../../metrics/workout'
import { withSpeedUnit } from '../../model/tree'
import type { Block, Profile, Recording, RecordingLink, Settings, SpeedUnit, Sport, Workout } from '../../model/types'
import { PROFILE_KEYS, profileOf, SPORT_LABEL, SPORTS } from '../../model/types'
import { fmtClock, fmtDuration, fmtPace, parsePaceInput } from '../../parser/format'
import { parseWorkout } from '../../parser/parser'
import { linkOffset, stepHr, stepWindows } from '../../recordings/align'
import { detectText } from '../../recordings/autolog'
import { canDetect } from '../../recordings/intervals'
import { serializeBlocks } from '../../parser/serialize'
import { TimelineBar } from '../charts/TimelineBar'
import { ShorthandInput } from './ShorthandInput'
import { StatsRow } from './StatsRow'
import { StepTable } from './StepTable'

export type Draft = Partial<Workout> & { date: string; sport: Sport }

interface Props {
  draft: Draft
  settings: Settings
  onClose: () => void
}

/** Parses "65m", "1h05m", "1:05:00" or bare minutes into seconds. */
function parseTotalTime(text: string): number | undefined {
  const [b] = parseWorkout(text.trim()).blocks
  return b?.type === 'step' ? b.duration : undefined
}

function profileSummary(p: Profile): string {
  return [
    `threshold pace ${p.thresholdSpeed ? `${fmtPace(p.thresholdSpeed)}/km` : 'not set'}`,
    p.ftp && `FTP ${p.ftp} W`,
    p.lthr && `LTHR ${p.lthr}`,
    p.maxHr && `max HR ${p.maxHr}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const optionalNumber = (v: string) => (v.trim() ? Number(v) : undefined)

/** Parses an offset as seconds ("90", "-15") or clock time ("1:30", "1:02:00"). */
function parseOffset(text: string): number | undefined {
  const m = /^(-?)(\d+(?::\d+){0,2})$/.exec(text.trim())
  if (!m) return undefined
  return (m[1] ? -1 : 1) * m[2].split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

function fmtOffset(secs: number): string {
  return `${secs < 0 ? '-' : ''}${fmtClock(Math.abs(secs))}`
}

export function WorkoutEditor({ draft, settings, onClose }: Props) {
  const [date, setDate] = useState(draft.date)
  const [sport, setSport] = useState<Sport>(draft.sport)
  const [title, setTitle] = useState(draft.title ?? '')
  const [rpe, setRpe] = useState(draft.rpe !== undefined ? String(draft.rpe) : '')
  const [totalText, setTotalText] = useState(draft.duration ? fmtDuration(draft.duration) : '')
  const [notes, setNotes] = useState(draft.notes ?? '')
  const [text, setText] = useState(draft.rawText ?? '')
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>(draft.speedUnit ?? settings.speedUnit)
  // Thresholds are copied from settings when the workout is first logged, then kept.
  const [profile, setProfile] = useState<Profile>(draft.profile ?? profileOf(settings))
  const [paceText, setPaceText] = useState(profile.thresholdSpeed ? fmtPace(profile.thresholdSpeed) : '')
  const [link, setLink] = useState<RecordingLink | undefined>(draft.recording)
  // Text as interval detection wrote it; the workout stays `generated` while the text still matches.
  const [generatedText, setGeneratedText] = useState(draft.generated ? draft.rawText : undefined)

  const parsed = useMemo(() => parseWorkout(text, { speedUnit }), [text, speedUnit])
  const rpeValue = rpe ? Math.min(10, Math.max(1, Number(rpe))) : undefined

  // Recorded HR from the linked recording, lined up with the plan by the link's offset.
  const recording = useLiveQuery(async () => {
    if (!link) return null
    const [rec, s] = await Promise.all([db.recordings.get(link.id), db.recordingStreams.get(link.id)])
    return rec ? { rec, streams: s } : null
  }, [link?.id])
  const streams = recording?.streams?.hr && recording.streams.t.length ? recording.streams : undefined
  const offset = linkOffset(link)
  const hr = streams ? { streams, offset } : undefined
  const hrByStep = useMemo(
    () => (streams ? stepHr(stepWindows(parsed.blocks, sport, profile, rpeValue, offset), streams) : undefined),
    [streams, parsed.blocks, sport, profile, rpeValue, offset],
  )
  const duration = totalText ? parseTotalTime(totalText) : undefined
  const workout = { sport, blocks: parsed.blocks, rpe: rpeValue, duration, profile }
  const totals = workoutTotals(workout, profile)
  const hasErrors = parsed.diagnostics.some((d) => d.severity === 'error')
  const current = profileOf(settings)
  const profileIsCurrent = PROFILE_KEYS.every((k) => profile[k] === current[k])

  // Structured edits rewrite the shorthand, which stays the source of truth.
  const onBlocksChange = (blocks: Block[]) => setText(serializeBlocks(withSpeedUnit(blocks, speedUnit)))

  // Switching units rewrites existing speeds so their values don't change. With
  // unparseable text we can't rewrite safely, so only the reading of new input changes.
  const changeSpeedUnit = (u: SpeedUnit) => {
    if (u === speedUnit) return
    if (!hasErrors && text.trim()) setText(serializeBlocks(withSpeedUnit(parsed.blocks, u)))
    setSpeedUnit(u)
  }

  const setThresholdPace = (v: string) => {
    setPaceText(v)
    setProfile({ ...profile, thresholdSpeed: parsePaceInput(v) })
  }

  const detect = () => {
    const detected = recording && detectText(recording.rec, recording.streams, profile)
    if (!detected) return
    if (recording.rec.sport === 'run') setSpeedUnit('pace')
    setText(detected.rawText)
    setGeneratedText(detected.rawText)
  }

  const save = async () => {
    await saveWorkout({
      ...draft,
      date,
      sport,
      title: title.trim() || undefined,
      notes: notes.trim() || undefined,
      rpe: rpeValue,
      duration,
      rawText: text.trim(),
      blocks: parsed.blocks,
      profile,
      speedUnit,
      recording: link,
      generated: generatedText !== undefined && text.trim() === generatedText.trim() ? true : undefined,
    })
    onClose()
  }

  const remove = async () => {
    if (draft.id && confirm('Delete this workout?')) {
      await deleteWorkout(draft.id)
      onClose()
    }
  }


  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-label={draft.id ? 'Edit workout' : 'Add workout'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
      >
        <header className="modal-head">
          <h2>{draft.id ? 'Edit workout' : 'Add workout'}</h2>
          <span className="meta">{fmtLongDate(date)}</span>
        </header>

        <div className="form-row">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Sport</span>
            <select value={sport} onChange={(e) => setSport(e.target.value as Sport)}>
              {SPORTS.map((s) => (
                <option key={s} value={s}>
                  {SPORT_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field narrow">
            <span>RPE</span>
            <input type="number" min={1} max={10} step={0.5} value={rpe} onChange={(e) => setRpe(e.target.value)} />
          </label>
          <label className="field">
            <span>Total time</span>
            <input
              value={totalText}
              onChange={(e) => setTotalText(e.target.value)}
              placeholder={totals.duration ? fmtClock(totals.duration) : 'e.g. 65m'}
              title="Optional. Covers time the structure doesn't describe."
              style={{ width: 96 }}
            />
          </label>
        </div>

        <RecordingRow
          date={date}
          workoutId={draft.id}
          link={link}
          onChange={setLink}
          hasHr={!!streams}
          onDetect={recording && canDetect(recording.rec, recording.streams) ? detect : undefined}
        />

        <ShorthandInput
          value={text}
          onChange={setText}
          highlights={parsed.highlights}
          diagnostics={parsed.diagnostics}
          speedUnit={speedUnit}
          onSpeedUnit={changeSpeedUnit}
          autoFocus={!draft.id}
        />

        <StatsRow totals={totals} sport={sport} speedUnit={speedUnit} />
        {totals.unknownDuration > 0 && (
          <p className="notice">
            {totals.unknownDuration} step{totals.unknownDuration > 1 ? 's have' : ' has'} no duration. Add a speed or
            pace so {totals.unknownDuration > 1 ? 'they count' : 'it counts'} toward time and zones.
          </p>
        )}
        {needsThresholdPace(workout, profile) && (
          <p className="notice">
            No threshold pace for this workout, so speed-based zones fall back to step type and RPE. Set it in Settings,
            or below for this workout only.
          </p>
        )}
        <TimelineBar
          blocks={parsed.blocks}
          sport={sport}
          profile={profile}
          speedUnit={speedUnit}
          rpe={rpeValue}
          hr={hr}
          stepHr={hrByStep}
        />
        <StepTable
          blocks={parsed.blocks}
          onChange={onBlocksChange}
          sport={sport}
          profile={profile}
          speedUnit={speedUnit}
          rpe={rpeValue}
          stepHr={hrByStep}
        />

        <details className="thresholds">
          <summary>
            Thresholds for this workout: {profileSummary(profile)}
            {!profileIsCurrent && <span className="warn"> (differs from Settings)</span>}
          </summary>
          <div className="form-row">
            <label className="field">
              <span>Threshold pace (min/km)</span>
              <input value={paceText} onChange={(e) => setThresholdPace(e.target.value)} placeholder="4:15" />
            </label>
            <label className="field">
              <span>FTP (W)</span>
              <input
                type="number"
                value={profile.ftp ?? ''}
                onChange={(e) => setProfile({ ...profile, ftp: optionalNumber(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Threshold HR</span>
              <input
                type="number"
                value={profile.lthr ?? ''}
                onChange={(e) => setProfile({ ...profile, lthr: optionalNumber(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Max HR</span>
              <input
                type="number"
                value={profile.maxHr ?? ''}
                onChange={(e) => setProfile({ ...profile, maxHr: optionalNumber(e.target.value) })}
              />
            </label>
          </div>
          {!profileIsCurrent && (
            <button
              type="button"
              onClick={() => {
                setProfile(current)
                setPaceText(current.thresholdSpeed ? fmtPace(current.thresholdSpeed) : '')
              }}
            >
              Use values from Settings
            </button>
          )}
        </details>

        <label className="field" style={{ marginTop: 12 }}>
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <footer className="modal-actions">
          {draft.id && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} title={hasErrors ? 'Unrecognised text is kept but ignored' : '⌘↵'}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}

function fmtStart(r: Recording): string {
  return new Date(r.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Commits on blur or Enter; invalid text reverts. */
function OffsetInput({ value, onChange }: { value: number; onChange: (secs: number) => void }) {
  const [draft, setDraft] = useState(fmtOffset(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(fmtOffset(value))
  }
  const commit = () => {
    const secs = parseOffset(draft)
    if (secs === undefined) setDraft(fmtOffset(value))
    else if (secs !== value) onChange(secs)
  }
  return (
    <input
      value={draft}
      aria-label="Plan starts at"
      style={{ width: 64 }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

/** The recording linked to this workout, or a picker of that day's unlinked recordings. */
function RecordingRow({
  date,
  workoutId,
  link,
  onChange,
  hasHr,
  onDetect,
}: {
  date: string
  workoutId?: string
  link?: RecordingLink
  onChange: (link: RecordingLink | undefined) => void
  hasHr: boolean
  onDetect?: () => void
}) {
  const linked = useLiveQuery(() => (link ? db.recordings.get(link.id) : undefined), [link?.id])
  const available = useLiveQuery(async () => {
    const [recordings, workouts] = await Promise.all([
      db.recordings.where('localDate').equals(date).sortBy('startTime'),
      db.workouts.where('date').equals(date).toArray(),
    ])
    const taken = new Set(workouts.filter((w) => w.id !== workoutId).map((w) => w.recording?.id))
    return recordings.filter((r) => !taken.has(r.id))
  }, [date, workoutId])

  if (link && linked) {
    const hr = [linked.avgHr && `avg HR ${Math.round(linked.avgHr)}`, linked.maxHr && `max ${Math.round(linked.maxHr)}`]
      .filter(Boolean)
      .join(' / ')
    return (
      <div className="recording-row">
        <span className="label">Recording</span>
        <span>
          <strong>{linked.name ?? linked.rawSport}</strong> · {fmtStart(linked)} · {fmtClock(linked.elapsed)}
          {hr && ` · ${hr}`}
          {link.linkedBy === 'auto' && <span className="meta"> · linked automatically</span>}
        </span>
        {linked.stravaId && (
          <a href={`https://www.strava.com/activities/${linked.stravaId}`} target="_blank" rel="noreferrer">
            Strava ↗
          </a>
        )}
        {hasHr && (
          <label className="inline-field" title="Time into the recording where step 1 starts: seconds or m:ss">
            Plan starts at
            <OffsetInput
              value={linkOffset(link)}
              onChange={(offset) => onChange({ ...link, alignment: { method: 'offset', offset } })}
            />
          </label>
        )}
        {onDetect && (
          <button onClick={onDetect} title="Replace the text with the structure found in the recording">
            Detect intervals
          </button>
        )}
        <button onClick={() => onChange(undefined)}>Unlink</button>
      </div>
    )
  }
  if (!available?.length) return null
  return (
    <div className="recording-row">
      <span className="label">Recording</span>
      <select
        value=""
        aria-label="Link a recording"
        onChange={(e) =>
          e.target.value &&
          onChange({ id: e.target.value, linkedBy: 'manual', alignment: { method: 'offset', offset: 0 } })
        }
      >
        <option value="">Link a recording from this day…</option>
        {available.map((r) => (
          <option key={r.id} value={r.id}>
            {fmtStart(r)} · {r.name ?? r.rawSport} · {fmtClock(r.elapsed)}
            {r.avgHr ? ` · ${Math.round(r.avgHr)} bpm` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
