import { fmtHours } from '../../parser/format'
import { useTooltip } from './Tooltip'

/** Horizontal stacked bar of time in each zone, keyed underneath with times and shares. */
export function ZoneBar({ zoneTime }: { zoneTime: number[] }) {
  const { show, hide, tip } = useTooltip()
  const total = zoneTime.reduce((a, b) => a + b, 0)
  if (!total) return <div className="empty">Nothing logged.</div>
  const pct = (secs: number) => Math.round((secs / total) * 100)
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height: 14 }} onMouseLeave={hide}>
        {zoneTime.map((secs, i) =>
          secs > 0 ? (
            <div
              key={i}
              style={{ flex: secs, background: `var(--z${i + 1})`, minWidth: 3 }}
              onMouseMove={(e) =>
                show(
                  e,
                  <span>
                    Z{i + 1}: {fmtHours(secs)} ({pct(secs)}%)
                  </span>,
                )
              }
            />
          ) : null,
        )}
      </div>
      <div className="zone-key">
        {zoneTime.map((secs, i) => (
          <span key={i} className={secs ? undefined : 'meta'}>
            <span className="swatch" style={{ background: `var(--z${i + 1})` }} />Z{i + 1}{' '}
            {fmtHours(secs)} <span className="meta">{pct(secs)}%</span>
          </span>
        ))}
      </div>
      {tip}
    </div>
  )
}
