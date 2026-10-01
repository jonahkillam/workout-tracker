import { useState, type InputHTMLAttributes } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  /** Gets the trimmed text on blur or Enter, if it changed. To reject it, don't change `value`: the input reverts. */
  onCommit: (text: string) => void
}

/**
 * Text input that commits on blur or Enter and follows `value` when it changes. Esc, or a commit that
 * leaves `value` as it was (rejected), puts the value back.
 */
export function CommitInput({ value, onCommit, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  const commit = () => {
    const text = draft.trim()
    if (text !== value) onCommit(text)
    // An accepted commit brings a new value, which replaces this; otherwise show the value as it was.
    setDraft(value)
  }
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Commit in place, keeping focus in the dialog so Esc still reaches it.
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          // Revert the cell, but leave the dialog open.
          e.preventDefault()
          setDraft(value)
        }
        onKeyDown?.(e)
      }}
    />
  )
}
