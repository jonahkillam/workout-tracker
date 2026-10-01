import type { Block, Profile, RecordingStreams, SpeedUnit, Sport, Step } from '../../model/types'
import { KIND_LABEL } from '../../model/types'
import { fmtDistance, fmtDuration, fmtRange, fmtSpeed, mid } from '../../parser/format'
import { bucketSeries, pauseSpans, stepSegments, type StepSegment } from '../../recordings/align'
import { effortMax, type Effort } from '../../recordings/derived'
import { linePath } from './linePath'
import { useTooltip } from './Tooltip'

interface Props {
  blocks: Block[]
  sport: Sport
  profile: Profile
  speedUnit?: SpeedUnit
  rpe?: number
  height?: number
  /** Compact mode for the week table: no incline track, caption or tooltips. */
  mini?: boolean
  /** Recorded HR to draw over the plan, with step 1 starting `offset` seconds into the recording. */
  recording?: { streams: RecordingStreams; offset: number }
  /** Recorded average HR per step, for the tooltip. */
  stepHr?: Map<Step, number>
  /** GAP, pace or power from the same recording, drawn as a grey line on a zero-based scale. */
  effort?: Effort
}

/**
 * Session profile. Width is time; height and colour both encode the intensity
 * zone, so work and recovery read apart at a glance. Incline, when present,
 * gets its own thin track underneath rather than sharing the zone axis.
 * Recorded HR, when given, is a red line on its own min–max scale over the
 * zones, and GAP, pace or power a grey line on a zero-based scale. With no
 * timed steps but a recording (an unstructured activity), only the lines show.
 */
export function TimelineBar({
  blocks,
  sport,
  profile,
  speedUnit = 'kmh',
  rpe,
  height = 48,
  mini = false,
  recording,
  stepHr,
  effort,
}: Props) {
  const { show, hide, tip } = useTooltip()
  const segments = stepSegments(blocks, sport, profile, rpe)
  const total = segments.reduce((sum, s) => sum + s.duration, 0)
  // If the recording ran past the plan, widen the axis so its tail still shows. With no plan, it's just the recording.
  const lastT = recording?.streams.t.length ? recording.streams.t[recording.streams.t.length - 1] - recording.offset : 0
  const domain = Math.max(total, lastT)
  if (!domain) return mini ? null : <div className="empty">No timed steps yet.</div>

  const width = 1000
  // Many short segments: drop the gap so thin ones don't vanish.
  const gap = segments.length > 80 ? 0 : 2
  const px = (secs: number) => (secs / domain) * width
  const zoneHeight = (zone: number) => (height * (zone + 1)) / 6
  const maxIncline = Math.max(0, ...segments.map((s) => mid(s.step.targets.incline) ?? 0))
  const inclineTrack = !mini && maxIncline > 0 ? 14 : 0

  const tooltip = (s: StepSegment) => (
    <div>
      <strong>{KIND_LABEL[s.step.kind]}</strong>
      {s.step.kind !== 'pause' && ` · Z${s.stats.zone}`}
      <div>
        {fmtDuration(s.duration)}
        {s.stats.distance ? ` · ${fmtDistance(Math.round(s.stats.distance))}` : ''}
      </div>
      {s.step.targets.speed && <div>{fmtSpeed(s.step.targets.speed, speedUnit === 'pace')}</div>}
      {s.step.targets.incline && <div>{fmtRange(s.step.targets.incline, '% incline')}</div>}
      {s.stats.vertical > 0 && <div>+{Math.round(s.stats.vertical)} m</div>}
      {stepHr?.has(s.step) && <div>Avg HR {Math.round(stepHr.get(s.step)!)} bpm</div>}
    </div>
  )

  // Pause steps are gaps: no bar, and the HR line breaks.
  const pauses = pauseSpans(segments)
  const hrLine =
    recording?.streams.hr &&
    hrPath(bucketSeries(recording.streams.t, recording.streams.hr, recording.offset, 0, domain, 500, pauses), domain, width, height)
  const effortSeries = recording && effort && bucketSeries(recording.streams.t, effort.values, recording.offset, 0, domain, 500, pauses)
  const eMax = effortSeries ? effortMax(effortSeries) : 1
  const effortLine =
    effortSeries &&
    linePath(effortSeries, (i) => (i + 0.5) * (width / 500), (v) => height - (v / eMax) * height, 10 / (domain / 500))

  return (
    <div className="timeline">
      <svg
        viewBox={`0 0 ${width} ${height + inclineTrack}`}
        preserveAspectRatio="none"
        width="100%"
        height={height + inclineTrack}
        role="img"
        aria-label="Session profile by zone"
        onMouseLeave={hide}
      >
        {segments.map((s, i) => {
          const x = px(s.start)
          const w = px(s.duration)
          const h = zoneHeight(s.stats.zone)
          const incline = mid(s.step.targets.incline) ?? 0
          const ih = maxIncline ? ((inclineTrack - 4) * incline) / maxIncline : 0
          return (
            <g key={i} onMouseMove={mini ? undefined : (e) => show(e, tooltip(s))}>
              {s.step.kind !== 'pause' && (
                <rect
                  x={x + gap / 2}
                  y={height - h}
                  width={Math.max(0.5, w - gap)}
                  height={h}
                  style={{ fill: `var(--z${s.stats.zone})` }}
                />
              )}
              {inclineTrack > 0 && ih > 0 && (
                <rect
                  x={x + gap / 2}
                  y={height + inclineTrack - ih}
                  width={Math.max(0.5, w - gap)}
                  height={ih}
                  style={{ fill: 'var(--incline)' }}
                />
              )}
              {/* Full-height hit target so short segments are easy to hover. */}
              {!mini && <rect x={x} y={0} width={w} height={height + inclineTrack} fill="transparent" />}
            </g>
          )
        })}
        {effortLine && (
          <g className="effort">
            <path className="halo" d={effortLine} />
            <path d={effortLine} />
          </g>
        )}
        {hrLine && (
          <path
            d={hrLine.d}
            fill="none"
            stroke="var(--hr)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>
      {!mini && (
        <div className="timeline-caption">
          <span>
            Height = zone{inclineTrack ? ` · grey track = incline (max ${maxIncline}%)` : ''}
            {hrLine ? ` · red line = recorded HR (${hrLine.min}–${hrLine.max} bpm)` : ''}
          </span>
          <ZoneLegend />
        </div>
      )}
      {tip}
    </div>
  )
}

/** SVG path for bucketed HR, scaled min–max into the zone area. Breaks the line at gaps over 10 s (pauses). */
function hrPath(series: (number | undefined)[], domain: number, width: number, height: number) {
  const values = series.filter((v) => v !== undefined)
  if (!values.length) return undefined
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max(2, (max - min) * 0.05)
  const y = (v: number) => height - ((v - min + pad) / (max - min + 2 * pad)) * height
  const step = width / series.length
  const d = linePath(series, (i) => (i + 0.5) * step, y, 10 / (domain / series.length))
  return { d, min: Math.round(min), max: Math.round(max) }
}

export function ZoneLegend() {
  return (
    <span className="zone-key">
      {[1, 2, 3, 4, 5].map((z) => (
        <span key={z}>
          <span className="swatch" style={{ background: `var(--z${z})` }} />Z{z}
        </span>
      ))}
    </span>
  )
}
