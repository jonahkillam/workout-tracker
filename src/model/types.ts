// Core domain model. Units: duration in seconds, distance in metres,
// speed in km/h, incline in percent grade.

export type Sport = 'run' | 'treadmill' | 'stair' | 'ride' | 'other'

export const SPORTS: Sport[] = ['run', 'treadmill', 'stair', 'ride', 'other']

export const SPORT_LABEL: Record<Sport, string> = {
  run: 'Run',
  treadmill: 'Treadmill',
  stair: 'Stair',
  ride: 'Ride',
  other: 'Other',
}

/** Inclusive numeric range. A single value is stored as min === max. */
export interface Range {
  min: number
  max: number
}

/** `pause` is time stopped (timer paused or standing still): it keeps the plan in line with a recording but isn't training. */
export type StepKind = 'wu' | 'cd' | 'work' | 'rest' | 'steady' | 'pause'

export const STEP_KINDS: StepKind[] = ['wu', 'work', 'rest', 'steady', 'cd', 'pause']

export const KIND_LABEL: Record<StepKind, string> = {
  wu: 'Warm-up',
  work: 'Work',
  rest: 'Rest',
  steady: 'Steady',
  cd: 'Cool-down',
  pause: 'Pause',
}

export interface Targets {
  incline?: Range
  speed?: Range
  /** Render speed as pace (min/km) instead of km/h when serializing. */
  asPace?: boolean
  power?: Range
  hr?: Range
  zone?: Range
  rpe?: number
  /** Stair climber steps per minute. */
  stepRate?: Range
  /** Machine level (stair climber, bike trainer). */
  level?: Range
}

export interface Step {
  type: 'step'
  kind: StepKind
  duration?: number
  distance?: number
  /** Stair climber floors. */
  floors?: number
  targets: Targets
}

export interface Repeat {
  type: 'repeat'
  count: number
  children: Block[]
  /** `-r`: leave out this repeat's final recovery (its trailing non-work step, in the last repetition). */
  skipLastRest?: boolean
}

export type Block = Step | Repeat

export interface Workout {
  id: string
  /** ISO date, YYYY-MM-DD. */
  date: string
  sport: Sport
  title?: string
  notes?: string
  /** Session RPE, 1-10. */
  rpe?: number
  /** Total duration override in seconds, for sessions without structure. */
  duration?: number
  rawText: string
  blocks: Block[]
  /**
   * Thresholds in effect when the workout was logged. Zones and load are computed
   * from this, so later changes to settings don't rewrite history.
   */
  profile?: Profile
  /** Unit this workout's speeds are shown and typed in. Defaults to the settings preference. */
  speedUnit?: SpeedUnit
  /** The recorded activity this workout is linked to, if any. */
  recording?: RecordingLink
  /** Written by interval detection and not edited since; reprocessing may rewrite it. */
  generated?: boolean
  createdAt: number
  updatedAt: number
}

/** How a workout's planned steps line up with its recording (used for the HR overlay). */
export type Alignment = { method: 'laps' } | { method: 'offset'; /** Seconds into the recording where step 1 starts. */ offset: number }

export interface RecordingLink {
  id: string
  linkedBy: 'auto' | 'manual'
  alignment: Alignment
}

export interface Lap {
  /** Seconds from the start of the recording. */
  start: number
  duration: number
  distance?: number
  /** Index of the watch-workout step this lap belongs to (FIT only). */
  stepIndex?: number
}

/** A recorded activity from any source (Strava now, FIT files later). */
export interface Recording {
  id: string
  stravaId?: number
  /** SHA-1 of an imported FIT file, to avoid importing it twice. */
  fitHash?: string
  streamsFrom?: 'strava' | 'fit'
  /** UTC ISO timestamp. */
  startTime: string
  /** Local calendar date, YYYY-MM-DD. */
  localDate: string
  sport: Sport
  /** Sport as the source named it, e.g. Strava's `sport_type`. */
  rawSport: string
  trainer?: boolean
  name?: string
  device?: string
  /** Seconds. */
  elapsed: number
  moving?: number
  /** Metres. */
  distance?: number
  elevationGain?: number
  avgHr?: number
  maxHr?: number
  laps: Lap[]
  /** When a workout was generated from this recording. Set once, so a deleted one isn't recreated. */
  autoLogged?: number
  /** When detection found no clear workout structure, so it's left as an unstructured activity. */
  unstructured?: number
  /** Totals and time-in-intensity worked out from the streams, once they've arrived. */
  recorded?: RecordedSummary
  /** Thresholds in effect when the summary was worked out, for zoning it without a workout. */
  profile?: Profile
  importedAt: number
  updatedAt: number
}

/** Moving seconds per bin: `secs[i]` is time spent from `i × bin` up to `(i + 1) × bin`. */
export interface Histogram {
  bin: number
  secs: number[]
}

/**
 * What a recording's streams add up to. Time in intensity is kept as histograms
 * rather than zones, so it can be zoned by whichever thresholds apply.
 */
export interface RecordedSummary {
  /** Seconds moving, not counting stops. */
  moving: number
  /** Metres. */
  distance: number
  /** Grade-adjusted speed (Minetti 2002), km/h. Outdoor runs only. */
  gap?: Histogram
  /** 30 s rolling power, W. Rides only. */
  power?: Histogram
  /** Heart rate, bpm. */
  hr?: Histogram
}

/** Per-sample data for a recording, kept apart because it's large. */
export interface RecordingStreams {
  recordingId: string
  /** Seconds from the start; pauses show up as gaps. */
  t: Uint32Array
  hr?: Uint8Array
  /** m/s. */
  speed?: Float32Array
  cadence?: Uint8Array
  power?: Uint16Array
  altitude?: Float32Array
  distance?: Float32Array
  /** Strava's sampling level, and the original point count, to spot downsampling. */
  resolution?: string
  originalSize?: number
}

export interface StravaAuth {
  id: 'strava'
  athleteId: number
  athleteName: string
  accessToken: string
  refreshToken: string
  /** Epoch seconds. */
  expiresAt: number
  scope: string
}

export interface StravaWeekFetch {
  weekStart: string
  fetchedAt: number
}

export interface WeekNote {
  /** ISO date of the Monday starting the week. */
  weekStart: string
  text: string
  updatedAt: number
}

/**
 * Athlete thresholds and equipment constants that metrics depend on. Thresholds
 * are optional: without one, the zones that depend on it aren't computed.
 */
export interface Profile {
  /** Threshold running speed on the flat, km/h (entered as a pace). Used for pace zones. */
  thresholdSpeed?: number
  /** Functional threshold power, watts. Used for power zones. */
  ftp?: number
  /** Lactate threshold heart rate, bpm. Used for heart-rate zones. */
  lthr?: number
  /** Maximum heart rate, bpm. */
  maxHr?: number
  /** Stair climber step height, metres. */
  stairStepHeight: number
  /** Height of one stair climber "floor", metres. */
  stairFloorHeight: number
}

export type SpeedUnit = 'kmh' | 'pace'

export interface Settings extends Profile {
  /** How speeds are shown, and how speeds typed without a unit are read. */
  speedUnit: SpeedUnit
}

export const THRESHOLD_KEYS = ['thresholdSpeed', 'ftp', 'lthr', 'maxHr'] as const

export const PROFILE_KEYS: (keyof Profile)[] = [...THRESHOLD_KEYS, 'stairStepHeight', 'stairFloorHeight']

export function profileOf(s: Profile): Profile {
  const p: Profile = { stairStepHeight: s.stairStepHeight, stairFloorHeight: s.stairFloorHeight }
  for (const k of THRESHOLD_KEYS) if (s[k] !== undefined) p[k] = s[k]
  return p
}

/** Only equipment constants have defaults; thresholds must come from the athlete. */
export const DEFAULT_SETTINGS: Settings = {
  // 16 steps per 3.25 m floor.
  stairStepHeight: 3.25 / 16,
  stairFloorHeight: 3.25,
  speedUnit: 'kmh',
}
