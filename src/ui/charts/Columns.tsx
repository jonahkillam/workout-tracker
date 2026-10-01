import { useTooltip } from './Tooltip'

interface Props {
  values: number[]
  labels: string[]
  /** Index drawn in the accent colour and value-labelled. */
  highlight?: number
  format: (v: number) => string
  height: number
  onSelect?: (index: number) => void
}

/** Single-series column chart: soft grey columns, the highlighted one dark. */
export function Columns({ values, labels, highlight, format, height, onSelect }: Props) {
  const { show, hide, tip } = useTooltip()
  const max = Math.max(...values, 0)
  const labelSpace = 14
  const plot = height - labelSpace
  // With many columns, label every third one plus the highlighted column.
  const showLabel = (i: number) => values.length <= 7 || i === highlight || (values.length - 1 - i) % 3 === 0
  return (
    <div onMouseLeave={hide}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height, position: 'relative' }}>
        {values.map((v, i) => {
          const h = max ? Math.max(v > 0 ? 2 : 0, (v / max) * (plot - labelSpace)) : 0
          const active = i === highlight
          return (
            <div
              key={i}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                height: '100%',
                minWidth: 0,
                cursor: onSelect ? 'pointer' : undefined,
              }}
              onClick={onSelect ? () => onSelect(i) : undefined}
              onMouseMove={(e) =>
                show(
                  e,
                  <span>
                    {labels[i]}: <strong>{format(v)}</strong>
                  </span>,
                )
              }
            >
              {active && v > 0 && (
                <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-2)', lineHeight: '14px' }}>{format(v)}</span>
              )}
              <div
                style={{
                  width: '100%',
                  maxWidth: 24,
                  height: h,
                  background: active ? 'var(--text)' : 'var(--mark-soft)',
                  borderRadius: '4px 4px 0 0',
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: `${labelSpace}px`, whiteSpace: 'nowrap' }}>
                {showLabel(i) ? labels[i] : '\u00a0'}
              </span>
            </div>
          )
        })}
      </div>
      {tip}
    </div>
  )
}
