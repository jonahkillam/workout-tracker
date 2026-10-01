import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { RUNNING } from '../../metrics/workout'
import type { RecordingStreams, SpeedUnit, Sport } from '../../model/types'
import { KIND_LABEL } from '../../model/types'
import { fmtClock, fmtDuration, fmtSpeedIn, num } from '../../parser/format'
import { fmtTargets } from '../../parser/serialize'
import { bucketSeries, pauseSpans, sampleAt, type StepSegment } from '../../recordings/align'
import { effortMax, type Effort } from '../../recordings/derived'
import { linePath } from './linePath'
import { paceTicks, timeTicks, valueTicks } from './ticks'
import { useTooltip } from './Tooltip'

interface Props {
  segments: StepSegment[]
  sport: Sport
  speedUnit: SpeedUnit
  /** The linked recording's streams, with step 1 starting `offset` seconds in. */
  recording?: { streams: RecordingStreams; offset: number }
  /** GAP, pace or power, overlaid on the HR with its own zero-based axis on the right. */
  effort?: Effort
  /** Visible range in seconds on the plan's clock; undefined shows everything. */
  view?: [number, number]
  onView: (view: [number, number] | undefined) => void
}

const HEIGHT = 220
const M = { top: 8, right: 8, bottom: 20, left: 34 }
/** Right margin when there's an effort axis. */
const EFFORT_RIGHT = 40
/** Narrowest zoom, in seconds. */
const MIN_SPAN = 20
/** Longer gaps between samples, in seconds, break the lines. */
const MAX_GAP = 10

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/**
 * Plan and recording on one time axis, drawn at real pixel size so it can be
 * zoomed: drag across it to zoom into a section, double-click to zoom out.
 * Zone bars follow the timeline's encoding. Recorded HR is a red line on the
 * left bpm axis; GAP, pace or power, when given, is a grey line on a zero-based
 * right axis, with the plan's target dashed. Hovering shows the step and the
 * recorded values at that moment.
 */
export function DetailChart({ segments, sport, speedUnit, recording, effort, view, onView }: Props) {
  const [ref, width] = useWidth()
  const clipId = useId()
  const { show, hide, tip } = useTooltip()
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const total = segments.reduce((end, s) => Math.max(end, s.start + s.duration), 0)
  const lastT = recording ? recording.streams.t[recording.streams.t.length - 1] - recording.offset : 0
  const domain = Math.max(total, lastT)
  const [from, to] = view ?? [0, domain]
  const showEffort = !!effort && !!recording
  const right = showEffort ? EFFORT_RIGHT : M.right
  const plotW = Math.max(0, width - M.left - right)
  const plotH = HEIGHT - M.top - M.bottom
  const bottom = M.top + plotH
  const x = (t: number) => ((t - from) / (to - from)) * plotW
  const tAt = (px: number) => from + (Math.min(plotW, Math.max(0, px)) / plotW) * (to - from)

  // One bucket per pixel, so zooming in shows full detail.
  // Pause steps are gaps: no bar, and the lines break.
  const buckets = Math.round(plotW)
  const bucketSecs = buckets ? (to - from) / buckets : 1
  const visibleSegs = useMemo(
    () => segments.filter((s) => s.step.kind !== 'pause' && s.start < to && s.start + s.duration > from),
    [segments, from, to],
  )

  // The recorded series depend on the data and the view, not the pointer, so hovering only redraws the cursor.
  const hrScale = useMemo(() => {
    const pauses = pauseSpans(segments)
    const hr = recording?.streams.hr
    const series = hr && buckets ? bucketSeries(recording.streams.t, hr, recording.offset, from, to, buckets, pauses) : []
    const values = series.filter((v) => v !== undefined)
    const pad = values.length ? Math.max(3, (Math.max(...values) - Math.min(...values)) * 0.08) : 0
    const lo = values.length ? Math.floor(Math.min(...values) - pad) : 0
    const hi = values.length ? Math.ceil(Math.max(...values) + pad) : 1
    return { series, hasValues: values.length > 0, lo, hi }
  }, [segments, recording, from, to, buckets])
  const { lo, hi } = hrScale
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * plotH
  // Bridge sampling gaps; break the line at pauses.
  const hrPath = useMemo(() => {
    const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * plotH
    return linePath(hrScale.series, (i) => M.left + i + 0.5, y, MAX_GAP / bucketSecs)
  }, [hrScale, lo, hi, bottom, plotH, bucketSecs])

  // Effort, zero-based: speed (km/h) or W up from the bottom. Pace is labelled
  // as min/km at its speed, so stopped is at the bottom and faster is higher.
  const asPace = effort?.kind !== 'power' && speedUnit === 'pace'
  const effortScale = useMemo(() => {
    const series =
      showEffort && buckets
        ? bucketSeries(recording!.streams.t, effort!.values, recording!.offset, from, to, buckets, pauseSpans(segments))
        : []
    const planned = showEffort
      ? visibleSegs.flatMap((s) => {
          const v = effort!.planned(s.step)
          return v ? [{ s, v }] : []
        })
      : []
    return { series, planned, max: effortMax(series, planned.map((p) => p.v)) }
  }, [showEffort, recording, effort, from, to, buckets, segments, visibleSegs])
  const { series: effortSeries, planned: plannedLevels, max: eMax } = effortScale
  const ey = (v: number) => bottom - (v / eMax) * plotH
  const effortPath = useMemo(
    () => linePath(effortSeries, (i) => M.left + i + 0.5, (v) => bottom - (v / eMax) * plotH, MAX_GAP / bucketSecs),
    [effortSeries, eMax, bottom, plotH, bucketSecs],
  )
  const effortTicks = asPace
    ? paceTicks(eMax, plotH).map((pace) => ({ v: 3600 / pace, label: fmtClock(pace) }))
    : valueTicks(0, eMax).map((v) => ({ v, label: num(v, 0) }))

  const pointerX = (e: PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left - M.left

  const onPointerDown = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const px = pointerX(e)
    setDrag({ a: px, b: px })
  }

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const px = pointerX(e)
    if (drag) setDrag({ ...drag, b: px })
    const t = tAt(px)
    setHover(t)
    show(e, readout(t, Math.min(buckets - 1, Math.max(0, Math.floor(px)))))
  }

  const onPointerUp = () => {
    if (!drag) return
    setDrag(null)
    if (Math.abs(drag.b - drag.a) < 4) return
    let [t0, t1] = [tAt(Math.min(drag.a, drag.b)), tAt(Math.max(drag.a, drag.b))]
    if (t1 - t0 < MIN_SPAN) {
      const mid = (t0 + t1) / 2
      ;[t0, t1] = [Math.max(0, mid - MIN_SPAN / 2), Math.min(domain, mid + MIN_SPAN / 2)]
    }
    onView([t0, t1])
  }

  const running = RUNNING.includes(sport)
  const readout = (t: number, bucket: number) => {
    const seg = segments.find((s) => t >= s.start && t < s.start + s.duration)
    const sample = recording && sampleAt(recording.streams, recording.offset, t)
    const targets = seg && fmtTargets(seg.step.targets)
    const gap = effort?.kind === 'gap' && sample ? effortSeries[bucket] : undefined
    return (
      <div>
        <strong>{fmtClock(t)}</strong>
        {seg && (
          <div>
            {KIND_LABEL[seg.step.kind]}
            {seg.step.kind !== 'pause' && ` · Z${seg.stats.zone}`} · {fmtDuration(seg.duration)}
            {targets && ` · ${targets}`}
          </div>
        )}
        {sample?.hr !== undefined && <div>HR {sample.hr} bpm</div>}
        {sample?.speed !== undefined && sample.speed > 0 && (
          <div>{fmtSpeedIn(sample.speed, running ? speedUnit : 'kmh')}</div>
        )}
        {gap !== undefined && <div>GAP {fmtSpeedIn(gap, speedUnit)}</div>}
        {/* Strava records run cadence per leg; double it for steps per minute. */}
        {!!sample?.cadence && <div>{running ? `${sample.cadence * 2} spm` : `${sample.cadence} rpm`}</div>}
        {!!sample?.power && <div>{sample.power} W</div>}
        {sample?.altitude !== undefined && <div>{num(sample.altitude, 0)} m altitude</div>}
      </div>
    )
  }

  return (
    <div ref={ref} className="detail-chart" style={{ height: HEIGHT }}>
      {plotW > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label="Session profile with recorded data">
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={0} width={plotW} height={bottom} />
            </clipPath>
          </defs>

          {hrScale.hasValues &&
            valueTicks(lo, hi).map((v) => (
              <g key={v}>
                <line className="grid" x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} />
                <text className="tick" x={M.left - 5} y={y(v) + 4} textAnchor="end">
                  {v}
                </text>
              </g>
            ))}
          {showEffort &&
            effortTicks.map(({ v, label }) => (
              <text key={label} className="tick" x={M.left + plotW + 5} y={ey(v) + 4} textAnchor="start">
                {label}
              </text>
            ))}

          <g clipPath={`url(#${clipId})`}>
            {visibleSegs.map((s, i) => {
              const x0 = x(s.start)
              const w = x(s.start + s.duration) - x0
              const h = (plotH * (s.stats.zone + 1)) / 6
              return (
                <rect
                  key={i}
                  x={M.left + x0 + (w > 4 ? 0.5 : 0)}
                  y={bottom - h}
                  width={Math.max(0.5, w > 4 ? w - 1 : w)}
                  height={h}
                  style={{ fill: `var(--z${s.stats.zone})` }}
                />
              )
            })}
            {/* A background-coloured halo keeps the grey lines readable over light and dark bars. */}
            {plannedLevels.map(({ s, v }, i) => (
              <g key={i} className="planned">
                <line className="halo" x1={M.left + x(s.start)} x2={M.left + x(s.start + s.duration)} y1={ey(v)} y2={ey(v)} />
                <line x1={M.left + x(s.start)} x2={M.left + x(s.start + s.duration)} y1={ey(v)} y2={ey(v)} />
              </g>
            ))}
            {effortPath && (
              <g className="effort">
                <path className="halo" d={effortPath} />
                <path d={effortPath} />
              </g>
            )}
            {hrPath && <path d={hrPath} fill="none" stroke="var(--hr)" strokeWidth={1.5} strokeLinejoin="round" />}
          </g>
          <line className="axis" x1={M.left} x2={M.left + plotW} y1={bottom} y2={bottom} />

          {timeTicks(from, to, Math.max(2, Math.floor(plotW / 70))).map((t) => (
            <text key={t} className="tick" x={M.left + x(t)} y={HEIGHT - 5} textAnchor="middle">
              {fmtClock(t)}
            </text>
          ))}

          {hover !== null && !drag && (
            <line className="crosshair" x1={M.left + x(hover)} x2={M.left + x(hover)} y1={M.top} y2={bottom} />
          )}
          {drag && (
            <rect
              className="selection"
              x={M.left + Math.max(0, Math.min(drag.a, drag.b))}
              y={M.top}
              width={Math.min(plotW, Math.max(drag.a, drag.b)) - Math.max(0, Math.min(drag.a, drag.b))}
              height={plotH}
            />
          )}

          <rect
            className="hit"
            x={0}
            y={0}
            width={width}
            height={HEIGHT}
            fill="transparent"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
            onPointerLeave={() => {
              setHover(null)
              hide()
            }}
            onDoubleClick={() => onView(undefined)}
          />
        </svg>
      )}
      {tip}
    </div>
  )
}
