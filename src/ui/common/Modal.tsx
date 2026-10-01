import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

interface Props {
  label: string
  /** Extra classes on the dialog, e.g. `narrow`. */
  className?: string
  onClose: () => void
  /** Runs before the dialog's own keys; call `preventDefault` to stop Esc closing it. */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/**
 * A dialog over a dimmed backdrop. Esc or a press on the backdrop closes it.
 * It takes focus when it opens (unless a field inside already has it), so Esc
 * works straight away, and hands focus back to whatever had it on close.
 */
export function Modal({ label, className, onClose, onKeyDown, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Read while rendering, before an autoFocus field inside takes focus.
  const [trigger] = useState(() => document.activeElement)
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [trigger])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.key === 'Escape' && !e.defaultPrevented) onClose()
        }}
      >
        {children}
      </div>
    </div>
  )
}
