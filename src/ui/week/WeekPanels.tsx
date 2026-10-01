import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, saveWeekNote } from '../../db/db'
import { fmtDay, weekDays } from '../../metrics/dates'
import type { WeekSummary } from '../../metrics/week'
import { Columns } from '../charts/Columns'
import { ZoneBar } from '../charts/ZoneBar'
import { useNarrow } from '../common/useNarrow'

interface Props {
  /** Consecutive weeks, oldest first; the last one is the week shown. */
  weeks: WeekSummary[]
  onSelectWeek: (start: string) => void
}

function WeekNotes({ start }: { start: string }) {
  const note = useLiveQuery(() => db.weekNotes.get(start), [start])
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <textarea
      className="week-notes"
      value={draft ?? note?.text ?? ''}
      placeholder="Notes for the week"
      aria-label="Notes for the week"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={async () => {
        if (draft !== null && draft !== (note?.text ?? '')) await saveWeekNote(start, draft)
        setDraft(null)
      }}
    />
  )
}

export function WeekPanels({ weeks, onSelectWeek }: Props) {
  const summary = weeks[weeks.length - 1]
  const labels = weeks.map((w) => fmtDay(w.start).day)
  // On a phone a tap is for reading the value, so the bars don't navigate.
  const selectWeek = useNarrow() ? undefined : (i: number) => onSelectWeek(weeks[i].start)
  return (
    <div className="panels">
      <section className="panel">
        <h2>Time in zones</h2>
        <ZoneBar zoneTime={summary.total.zoneTime} />
      </section>
      <section className="panel">
        <h2>Load by day</h2>
        <Columns
          values={summary.dailyLoad}
          labels={weekDays(summary.start).map((d) => fmtDay(d).weekday)}
          format={(v) => String(Math.round(v))}
          highlight={summary.dailyLoad.indexOf(Math.max(...summary.dailyLoad))}
          height={90}
        />
      </section>
      <section className="panel">
        <h2>Load, last {weeks.length} weeks</h2>
        <Columns
          values={weeks.map((w) => w.total.load)}
          labels={labels}
          format={(v) => String(Math.round(v))}
          highlight={weeks.length - 1}
          onSelect={selectWeek}
          height={90}
        />
      </section>
      <section className="panel">
        <h2>Climb, last {weeks.length} weeks (m)</h2>
        <Columns
          values={weeks.map((w) => w.total.vertical)}
          labels={labels}
          format={(v) => Math.round(v).toLocaleString()}
          highlight={weeks.length - 1}
          onSelect={selectWeek}
          height={90}
        />
      </section>
      <section className="panel wide">
        <h2>Week notes</h2>
        <WeekNotes key={summary.start} start={summary.start} />
      </section>
    </div>
  )
}
