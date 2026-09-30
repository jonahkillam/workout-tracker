import { useState, type ReactNode, type MouseEvent } from 'react'

interface TipState {
  x: number
  y: number
  content: ReactNode
}

/** Hover tooltip that follows the pointer. Render `tip` once inside the chart. */
export function useTooltip() {
  const [state, setState] = useState<TipState | null>(null)
  const show = (e: MouseEvent, content: ReactNode) => setState({ x: e.clientX, y: e.clientY, content })
  const hide = () => setState(null)
  const tip = state ? (
    <div className="tooltip" style={{ left: state.x + 12, top: state.y + 12 }} role="tooltip">
      {state.content}
    </div>
  ) : null
  return { show, hide, tip }
}
