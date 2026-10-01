import { useEffect, type ReactNode } from 'react'
import { Modal } from './Modal'

interface Props {
  title: string
  onDone: () => void
  /** Also runs on Esc. The caller puts back whatever the sheet changed. */
  onCancel: () => void
  children: ReactNode
}

/**
 * A full-screen dialog for editing one thing on a phone, opened over the dialog it belongs to.
 * Cancel and Done sit at the top, and the sheet ends where the on-screen keyboard begins.
 */
export function Sheet({ title, onDone, onCancel, children }: Props) {
  // The layout viewport doesn't shrink for the keyboard on iOS, so the height comes from the visual one.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const fit = () => root.style.setProperty('--sheet-height', `${vv.height}px`)
    fit()
    vv.addEventListener('resize', fit)
    return () => {
      vv.removeEventListener('resize', fit)
      root.style.removeProperty('--sheet-height')
    }
  }, [])

  return (
    // Keys stop here, so Esc closes the sheet and not the dialog underneath.
    <Modal label={title} className="sheet" onClose={onCancel} onKeyDown={(e) => e.stopPropagation()}>
      <header className="modal-head">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <h2>{title}</h2>
        <button
          type="button"
          className="primary"
          onClick={() => {
            // A field that commits on blur gets to commit before the sheet goes.
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            onDone()
          }}
        >
          Done
        </button>
      </header>
      <div className="sheet-body">{children}</div>
    </Modal>
  )
}
