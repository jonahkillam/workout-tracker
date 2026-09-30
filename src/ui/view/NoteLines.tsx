import type { Note } from '../../model/types'
import { NOTE_LABEL } from '../../model/types'

/** A workout's notes, one per line, labelled by category (general notes go unlabelled). */
export function NoteLines({ notes, clamp }: { notes: Note[]; clamp?: boolean }) {
  return (
    <div className={`note-lines${clamp ? ' clamp' : ''}`}>
      {notes.map((n, i) => (
        <div key={i}>
          {n.kind !== 'general' && <span className="note-kind">{NOTE_LABEL[n.kind]}: </span>}
          {n.text}
        </div>
      ))}
    </div>
  )
}
