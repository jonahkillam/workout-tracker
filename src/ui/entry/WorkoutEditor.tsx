import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { db, deleteWorkout, normalizeNotes, saveTemplate, saveWorkout } from '../../db/db'
import { fmtLongDate } from '../../metrics/dates'
import { needsThresholdPace, workoutTotals } from '../../metrics/workout'
import { withSpeedUnit } from '../../model/tree'
import type { Block, Note, Profile, Recording, RecordingLink, Settings, SpeedUnit, Sport, Template, Workout } from '../../model/types'
import { PROFILE_KEYS, profileOf, SPORT_LABEL, SPORTS } from '../../model/types'
import { fmtClock, fmtDuration, fmtPace } from '../../parser/format'
import { parseWorkout } from '../../parser/parser'
import { linkOffset, stepAverage, stepWindows } from '../../recordings/align'
import { detectText } from '../../recordings/autolog'
import { canDetect } from '../../recordings/intervals'
import { newLink } from '../../recordings/match'
import { serializeBlocks, textInSpeedUnit } from '../../parser/serialize'
import { TimelineBar } from '../charts/TimelineBar'
import { CommitInput } from '../common/CommitInput'
import { Modal } from '../common/Modal'
import { fmtStart } from '../common/recording'
import { RecordingSummary } from '../common/RecordingSummary'
import { ThresholdFields } from '../common/ThresholdFields'
import { NotesEditor } from './NotesEditor'
import { ShorthandInput } from './ShorthandInput'
import { StatsRow } from './StatsRow'
import { StepTable } from './StepTable'
import { useEnsureStreams } from '../../strava/useStreams'

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

/** The workout's thresholds, plus its stair heights when they differ from Settings' (the editor has no fields for those). */
function profileSummary(p: Profile, current: Profile): string {
  return [
    `threshold pace ${p.thresholdSpeed ? `${fmtPace(p.thresholdSpeed)}/km` : 'not set'}`,
    p.ftp && `FTP ${p.ftp} W`,
    p.lthr && `LTHR ${p.lthr}`,
    p.maxHr && `max HR ${p.maxHr}`,
    p.stairStepHeight !== current.stairStepHeight && `step ${p.stairStepHeight} m`,
    p.stairFloorHeight !== current.stairFloorHeight && `floor ${p.stairFloorHeight} m`,
  ]
    .filter(Boolean)
    .join(' · ')
}

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
  const [notes, setNotes] = useState<Note[]>(draft.notes?.length ? draft.notes : [{ kind: 'general', text: '' }])
  // Opens in the current unit, whichever the workout was typed in.
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>(settings.speedUnit)
  const [text, setText] = useState(() =>
    textInSpeedUnit(draft.rawText ?? '', draft.speedUnit ?? settings.speedUnit, settings.speedUnit),
  )
  // Thresholds are copied from settings when the workout is first logged, then kept.
  const [profile, setProfile] = useState<Profile>(draft.profile ?? profileOf(settings))
  const [paceText, setPaceText] = useState(profile.thresholdSpeed ? fmtPace(profile.thresholdSpeed) : '')
  const [link, setLink] = useState<RecordingLink | undefined>(draft.recording)
  // The recording last unlinked, so it isn't linked again automatically.
  const [unlinked, setUnlinked] = useState(draft.unlinked)

  const parsed = useMemo(() => parseWorkout(text, { speedUnit }), [text, speedUnit])
  const rpeValue = rpe ? Math.min(10, Math.max(1, Number(rpe))) : undefined

  // Recorded HR from the linked recording, lined up with the plan by the link's offset.
  const loaded = useLiveQuery(async () => {
    if (!link) return null
    const [rec, s] = await Promise.all([db.recordings.get(link.id), db.recordingStreams.get(link.id)])
    return rec ? { rec, streams: s } : null
  }, [link?.id])
  // The query answers for the previous link until it re-runs.
  const recording = loaded && loaded.rec.id === link?.id ? loaded : undefined
  useEnsureStreams(link ? [link.id] : [])
  const streams = recording?.streams?.hr && recording.streams.t.length ? recording.streams : undefined
  const offset = linkOffset(link)
  const hrByStep = useMemo(
    () => (streams?.hr ? stepAverage(stepWindows(parsed.blocks, sport, profile, rpeValue, offset), streams.t, streams.hr) : undefined),
    [streams, parsed.blocks, sport, profile, rpeValue, offset],
  )
  const duration = totalText ? parseTotalTime(totalText) : undefined
  const workout = { sport, blocks: parsed.blocks, rpe: rpeValue, duration, profile }
  const totals = workoutTotals(workout, profile)
  const hasErrors = parsed.diagnostics.some((d) => d.severity === 'error')
  const current = profileOf(settings)
  const profileIsCurrent = PROFILE_KEYS.every((k) => profile[k] === current[k])

  // Structured edits rewrite the shorthand, which stays the source of truth. Text that didn't parse
  // would be lost in the rewrite, so the table is read-only until it's fixed.
  const onBlocksChange = (blocks: Block[]) => {
    if (!hasErrors) setText(serializeBlocks(withSpeedUnit(blocks, speedUnit)))
  }

  // Switching units rewrites existing speeds so their values don't change. With
  // unparseable text we can't rewrite safely, so only the reading of new input changes.
  const changeSpeedUnit = (u: SpeedUnit) => {
    if (u === speedUnit) return
    if (!hasErrors && text.trim()) setText(serializeBlocks(withSpeedUnit(parsed.blocks, u)))
    setSpeedUnit(u)
  }

  // A recording from another day no longer belongs to this workout.
  const changeDate = (d: string) => {
    setDate(d)
    if (link && recording && recording.rec.localDate !== d) setLink(undefined)
  }

  const templates = useLiveQuery(() => db.templates.orderBy('id').toArray(), [])
  const byName = [...(templates ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  const applyTemplate = (t: Template) => {
    if (text.trim() && text.trim() !== t.rawText && !confirm('Replace this workout\u2019s steps with the template?')) return
    setSport(t.sport)
    setText(textInSpeedUnit(t.rawText, t.speedUnit ?? speedUnit, speedUnit))
    if (!title.trim()) setTitle(t.name)
  }

  const saveAsTemplate = async () => {
    const name = prompt('Template name', title.trim())?.trim()
    if (!name) return
    // Saving under an existing name replaces that template.
    const existing = byName.find((t) => t.name === name)
    if (existing && !confirm(`Replace the template \u201c${name}\u201d?`)) return
    await saveTemplate({ id: existing?.id, name, sport, rawText: text.trim(), speedUnit })
  }

  const detect = () => {
    const detected = recording && detectText(recording.rec, recording.streams, profile)
    if (!detected) return
    setText(textInSpeedUnit(detected.rawText, 'pace', speedUnit))
  }

  // One save at a time, so a double-click or a repeating ⌘↵ can't add the workout twice.
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      await saveWorkout({
        ...draft,
        date,
        sport,
        title: title.trim() || undefined,
        notes: normalizeNotes(notes),
        rpe: rpeValue,
        duration,
        rawText: text.trim(),
        blocks: parsed.blocks,
        profile,
        speedUnit,
        recording: link,
        unlinked,
      })
      onClose()
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  // ⌘↵ in a table cell commits the cell as it blurs, but the edit only reaches `text` on the next render.
  // So the shortcut asks for a save, which runs after that render.
  const [saveRequests, setSaveRequests] = useState(0)
  const saveLatest = useEffectEvent(() => void save())
  useEffect(() => {
    if (saveRequests) saveLatest()
  }, [saveRequests])

  const remove = async () => {
    if (draft.id && confirm('Delete this workout?')) {
      await deleteWorkout(draft.id)
      onClose()
    }
  }

  return (
    <Modal
      label={draft.id ? 'Edit workout' : 'Add workout'}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          setSaveRequests((n) => n + 1)
        }
      }}
    >
      <header className="modal-head">
        <h2>{draft.id ? 'Edit workout' : 'Add workout'}</h2>
        <span className="meta">{fmtLongDate(date)}</span>
      </header>

      <div className="form-row">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => e.target.value && changeDate(e.target.value)} />
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
          <input value={title} onChange={(e) => setTitle(e.target.value)} enterKeyHint="done" />
        </label>
        <label className="field narrow">
          <span>RPE</span>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            max={10}
            step={0.5}
            value={rpe}
            onChange={(e) => setRpe(e.target.value)}
          />
        </label>
        <label className="field total-time">
          <span>Total time</span>
          <input
            value={totalText}
            onChange={(e) => setTotalText(e.target.value)}
            placeholder={totals.duration ? fmtClock(totals.duration) : 'e.g. 65m'}
            title="Optional. Covers time the structure doesn't describe."
            enterKeyHint="done"
          />
        </label>
      </div>

      <RecordingRow
        date={date}
        workoutId={draft.id}
        link={link}
        linked={recording?.rec}
        onChange={(l) => {
          if (!l && link) setUnlinked(link.id)
          setLink(l)
        }}
        hasHr={!!streams}
        onDetect={recording && canDetect(recording.rec, recording.streams) ? detect : undefined}
      />

      <div className="form-row templates">
        {byName.length > 0 && (
          <select
            aria-label="Template"
            value=""
            onChange={(e) => {
              const t = byName.find((x) => x.id === e.target.value)
              if (t) applyTemplate(t)
            }}
          >
            <option value="">From template…</option>
            {byName.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({SPORT_LABEL[t.sport]})
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={saveAsTemplate} disabled={!text.trim() || hasErrors}>
          Save as template
        </button>
      </div>

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
        recording={streams && { streams, offset }}
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
        readOnly={hasErrors}
      />
      {hasErrors && parsed.blocks.length > 0 && (
        <p className="help">
          The table is read-only until the highlighted text is fixed, so editing it can&rsquo;t drop that text.
        </p>
      )}

      <details className="thresholds">
        <summary>
          Thresholds for this workout: {profileSummary(profile, current)}
          {!profileIsCurrent && <span className="warn"> (differs from Settings)</span>}
        </summary>
        <div className="form-row">
          <ThresholdFields
            profile={profile}
            paceText={paceText}
            onChange={(p, t) => {
              setProfile(p)
              setPaceText(t)
            }}
          />
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

      <div className="field" style={{ marginTop: 12 }}>
        <span>Notes</span>
        <NotesEditor notes={notes} onChange={setNotes} />
      </div>

      <footer className="modal-actions">
        {draft.id && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={save}
          disabled={busy}
          title={hasErrors ? 'Unrecognised text is kept but ignored' : '⌘↵'}
        >
          Save
        </button>
      </footer>
    </Modal>
  )
}

/** The recording linked to this workout, or a picker of that day's unlinked recordings. */
function RecordingRow({
  date,
  workoutId,
  link,
  linked,
  onChange,
  hasHr,
  onDetect,
}: {
  date: string
  workoutId?: string
  link?: RecordingLink
  /** The linked recording, once loaded. */
  linked?: Recording
  onChange: (link: RecordingLink | undefined) => void
  hasHr: boolean
  onDetect?: () => void
}) {
  const available = useLiveQuery(async () => {
    const [recordings, workouts] = await Promise.all([
      db.recordings.where('localDate').equals(date).sortBy('startTime'),
      db.workouts.where('date').equals(date).toArray(),
    ])
    const taken = new Set(workouts.filter((w) => w.id !== workoutId).map((w) => w.recording?.id))
    return recordings.filter((r) => !taken.has(r.id))
  }, [date, workoutId])

  if (link && linked) {
    const offset = linkOffset(link)
    return (
      <RecordingSummary recording={linked} note={link.linkedBy === 'auto' ? 'linked automatically' : undefined}>
        {hasHr && (
          <label className="inline-field" title="Time into the recording where step 1 starts: seconds or m:ss">
            Plan starts at
            <CommitInput
              aria-label="Plan starts at"
              style={{ width: 64 }}
              value={fmtOffset(offset)}
              onCommit={(v) => {
                const secs = parseOffset(v)
                if (secs !== undefined && secs !== offset) onChange({ ...link, offset: secs })
              }}
            />
          </label>
        )}
        {onDetect && (
          <button onClick={onDetect} title="Replace the text with the structure found in the recording">
            Detect intervals
          </button>
        )}
        <button onClick={() => onChange(undefined)}>Unlink</button>
      </RecordingSummary>
    )
  }
  if (!available?.length) return null
  return (
    <div className="recording-row">
      <span className="label">Recording</span>
      <select
        value=""
        aria-label="Link a recording"
        onChange={(e) => e.target.value && onChange(newLink(e.target.value, 'manual'))}
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
