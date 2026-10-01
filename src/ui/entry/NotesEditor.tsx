import { useEffect, useRef, useState } from 'react'
import type { Note, NoteKind } from '../../model/types'
import { NOTE_KINDS, NOTE_LABEL } from '../../model/types'
import { Sheet } from '../common/Sheet'
import { useNarrow } from '../common/useNarrow'

interface Props {
  notes: Note[]
  onChange: (notes: Note[]) => void
}

/**
 * One row per note: category, text, remove. Empty rows are dropped when the workout is saved.
 * At phone width a row shows the note and opens it in a sheet to write.
 */
export function NotesEditor({ notes, onChange }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const added = useRef(false)
  const narrow = useNarrow()
  // The note open in the sheet, and what Cancel puts back: its old content, or nothing if it was just added.
  const [open, setOpen] = useState<{ i: number; original?: Note } | null>(null)

  // Focus the row that "Add" just appended.
  useEffect(() => {
    if (!added.current) return
    added.current = false
    const inputs = list.current?.querySelectorAll('textarea')
    inputs?.[inputs.length - 1]?.focus()
  }, [notes.length])

  const update = (i: number, note: Note) => onChange(notes.map((n, j) => (j === i ? note : n)))
  const remove = (i: number) => onChange(notes.filter((_, j) => j !== i))
  const add = (kind: NoteKind) => {
    if (narrow) setOpen({ i: notes.length })
    else added.current = true
    onChange([...notes, { kind, text: '' }])
  }
  const addLinks = (
    <div className="note-add">
      Add:
      {NOTE_KINDS.map((k) => (
        <button key={k} type="button" className="link" onClick={() => add(k)}>
          {NOTE_LABEL[k]}
        </button>
      ))}
    </div>
  )
  const kindSelect = (i: number, n: Note) => (
    <select aria-label="Category" value={n.kind} onChange={(e) => update(i, { ...n, kind: e.target.value as NoteKind })}>
      {NOTE_KINDS.map((k) => (
        <option key={k} value={k}>
          {NOTE_LABEL[k]}
        </option>
      ))}
    </select>
  )

  if (narrow) {
    const note = open && notes[open.i]
    const close = () => setOpen(null)
    return (
      <div className="notes-editor">
        {notes.map((n, i) => (
          <button key={i} type="button" className="tap-field note-tap" onClick={() => setOpen({ i, original: n })}>
            <span className="note-kind">{NOTE_LABEL[n.kind]}</span>
            {n.text ? <span className="note-text">{n.text}</span> : <span className="empty">Add a note</span>}
          </button>
        ))}
        {addLinks}
        {open && note && (
          <Sheet
            title={NOTE_LABEL[note.kind]}
            onDone={close}
            onCancel={() => {
              if (!open.original) remove(open.i)
              else if (note !== open.original) update(open.i, open.original)
              close()
            }}
          >
            <label className="field">
              <span>Category</span>
              {kindSelect(open.i, note)}
            </label>
            <label className="field">
              <span>Text</span>
              <textarea
                rows={6}
                autoFocus
                value={note.text}
                onChange={(e) => update(open.i, { ...note, text: e.target.value })}
              />
            </label>
            <div className="sheet-actions">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  remove(open.i)
                  close()
                }}
              >
                Remove
              </button>
            </div>
          </Sheet>
        )}
      </div>
    )
  }

  return (
    <div className="notes-editor" ref={list}>
      {notes.map((n, i) => (
        <div className="note-row" key={i}>
          {kindSelect(i, n)}
          <textarea
            rows={1}
            aria-label={NOTE_LABEL[n.kind]}
            value={n.text}
            onChange={(e) => update(i, { ...n, text: e.target.value })}
          />
          <button className="icon danger" title="Remove" onClick={() => remove(i)}>
            ✕
          </button>
        </div>
      ))}
      {addLinks}
    </div>
  )
}
