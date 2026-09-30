import { useEffect, useRef } from 'react'
import type { Note, NoteKind } from '../../model/types'
import { NOTE_KINDS, NOTE_LABEL } from '../../model/types'

interface Props {
  notes: Note[]
  onChange: (notes: Note[]) => void
}

/** One row per note: category, text, remove. Empty rows are dropped when the workout is saved. */
export function NotesEditor({ notes, onChange }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const added = useRef(false)

  // Focus the row that "Add" just appended.
  useEffect(() => {
    if (!added.current) return
    added.current = false
    const inputs = list.current?.querySelectorAll('textarea')
    inputs?.[inputs.length - 1]?.focus()
  }, [notes.length])

  const update = (i: number, note: Note) => onChange(notes.map((n, j) => (j === i ? note : n)))
  const add = (kind: NoteKind) => {
    added.current = true
    onChange([...notes, { kind, text: '' }])
  }

  return (
    <div className="notes-editor" ref={list}>
      {notes.map((n, i) => (
        <div className="note-row" key={i}>
          <select
            aria-label="Category"
            value={n.kind}
            onChange={(e) => update(i, { ...n, kind: e.target.value as NoteKind })}
          >
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {NOTE_LABEL[k]}
              </option>
            ))}
          </select>
          <textarea
            rows={1}
            aria-label={NOTE_LABEL[n.kind]}
            value={n.text}
            onChange={(e) => update(i, { ...n, text: e.target.value })}
          />
          <button className="icon danger" title="Remove" onClick={() => onChange(notes.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="note-add">
        Add:
        {NOTE_KINDS.map((k) => (
          <button key={k} type="button" className="link" onClick={() => add(k)}>
            {NOTE_LABEL[k]}
          </button>
        ))}
      </div>
    </div>
  )
}
