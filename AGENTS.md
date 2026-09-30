# AGENTS.md

A training log for running, treadmill (incline), stair climber and cycling workouts. Workouts are typed in a compact shorthand, parsed live, and summarised per week. The syntax and features are covered in `README.md`.

## Stack and commands

TypeScript + React 19 + Vite. Data is stored in the browser (IndexedDB via Dexie). The only server code is Strava token handling (`server/strava.ts`), served by the Vite dev/preview server locally and by a Vercel function (`api/strava/[action].ts`) when deployed. Node is pinned by `mise.toml`.

```
mise run dev         # dev server
mise run check       # typecheck + lint (oxlint) + tests (vitest) — run before finishing
mise run build       # production build
mise run test:watch
```

`npm run dev|build|test|lint` also work. There is no formatter config. Match the existing style: 2-space indent, single quotes, no semicolons, ~120-column lines.

## Layout

| Path | What |
|---|---|
| `src/model/types.ts` | Domain types: `Workout`, `Block` (`Step` \| `Repeat`), `Targets`, `Profile`, `Settings` |
| `src/model/tree.ts` | Block tree helpers: `expand` (applies `skipLastRest`), `occurrences`, path edits, `withSpeedUnit` |
| `src/parser/tokenizer.ts`, `parser.ts` | Shorthand → `Block[]` + diagnostics + highlight spans |
| `src/parser/serialize.ts` | `Block[]` → canonical shorthand (used when the step table edits a workout) |
| `src/parser/summary.ts` | One-line main-set headline for the week view |
| `src/parser/format.ts` | Number, duration, pace and speed formatting |
| `src/metrics/workout.ts` | Per-step stats, zones, load, Minetti grade cost, GAP, workout totals |
| `src/metrics/week.ts`, `dates.ts` | Week summaries, acute:chronic ratio, ISO weeks, local-date helpers |
| `src/db/db.ts` | Dexie schema (DB `training-log`), save/import/export |
| `src/strava/` | OAuth client (`auth.ts`), API reads (`api.ts`), response mapping (`map.ts`), week sync (`sync.ts`, `useWeekSync.ts`) |
| `src/recordings/match.ts` | Recording ↔ workout auto-linking and same-activity dedupe |
| `src/recordings/intervals.ts`, `autolog.ts`, `recorded.ts` | Structure detection, auto-logging, recorded summaries |
| `src/metrics/recorded.ts` | Totals from recorded data |
| `server/strava.ts`, `api/strava/[action].ts` | Token exchange/refresh/revoke (holds the client secret) |
| `src/ui/week/` | Main view: `WeekTable` (one row per session) and `WeekPanels` |
| `src/ui/entry/` | Workout editor: shorthand input, timeline, editable step table |
| `src/ui/charts/`, `tools/`, `settings/` | Charts, GAP calculator, settings dialog |

Units inside the model: seconds, metres, km/h, and incline as percent grade. Convert only when formatting.

## Invariants

- **The shorthand text is the source of truth.** `rawText` is what the user typed. Structured edits in the step table go `Block[]` → `serializeBlocks` → text → re-parse. `parse(serialize(b))` must deep-equal `b`. Any grammar change needs a round-trip case in `parser.test.ts`.
- **Parser semantics:**
  - Incline and level written once apply to work and rest. Intensity targets (speed, pace, power, HR, zone, RPE) apply to work only.
  - `a//b` splits a target between work and rest.
  - Bare numbers in a work/rest pair are seconds.
  - A unitless speed is read in the workout's `speedUnit` and emits a warning. `m:ss` is always a pace.
  - Inside a repeat's `(…)`, steps without a role word are work, except the last step of the repeat, which is rest. A single step is work. The serializer writes `easy` for steady steps inside repeats so they round-trip.
  - `-r` sets `Repeat.skipLastRest` on the repeat it follows. In that repeat's last repetition, its trailing non-work step is dropped; if it ends in a nested repeat, the drop passes down to that repeat's last repetition. Nested repeats only drop their own recovery if they carry their own `-r`. `r3m` / `w/ 90s` is a set rest appended to the outermost repeat.
- **Thresholds are snapshotted per workout** (`Workout.profile`). Metrics must use `w.profile ?? fallback`, never the current settings directly.
  - Changing Settings must not alter past zones. The one exception: `saveSettings` fills in thresholds that a workout has no value for.
  - Thresholds have no defaults. Code must handle `thresholdSpeed`, `ftp`, `lthr` and `maxHr` being undefined.
- **Totals iterate `expand(blocks)`**, never `count ×` multiplication, so `skipLastRest` is respected.
- **Dexie migrations:** never edit an existing `db.version(n)`. Add a new version with an `upgrade`.
- **Recordings are source-agnostic.** Strava is the first source and FIT import is planned. A `Recording` holds the summary and laps; its per-sample arrays live in `recordingStreams` as typed arrays. A workout links to at most one recording (`Workout.recording`), which also stores how its steps line up with the recording (`alignment`).
  - Week totals (table rows, footer, panels) come from the recording for runs with a GAP histogram and rides with a power histogram (`sessionTotals` in `metrics/recorded.ts`). Unlinked recordings count as unstructured sessions (`recordedTotals`). Treadmill and stair workouts, the editor, the viewer and planned zones stay plan-based.
  - `Recording.recorded` holds the moving time, distance and GAP/power/HR histograms, computed once from the streams (`recordings/recorded.ts`). Histograms don't depend on thresholds; zone them with `w.profile ?? fallback`, or `Recording.profile` for unlinked ones.
  - Auto-logging only creates a workout when detection finds clear workout structure (`looksLikeWorkout` in `recordings/intervals.ts`). Other runs and rides are marked `Recording.unstructured` and stay unstructured activities.
  - Auto-linking never overrides a manual link.
  - Recordings starting within 60 s of each other are the same activity and are merged.
- **Strava token boundary.** Only the code exchange, refresh and revoke go through `/api/strava/*`, because they need the client secret and Strava's token endpoint has no CORS. Data calls go straight from the browser to `https://www.strava.com/api/v3` (CORS allowed).
  - Refresh tokens rotate: keep the newest, and refresh single-flight.
  - Respect the read rate limit (100 per 15 min): on 429, stop and don't mark the week as fetched.
- **Dates** are local ISO strings (`YYYY-MM-DD`); use the helpers in `metrics/dates.ts`. Weeks start on Monday.

## UI conventions

The user has asked for a **plain, dense, utilitarian** look, like intervals.icu or a spreadsheet:
- System font at 13px, hairline borders, standard buttons.
- Plain labels ("Time in zones", not clever copy).
- No decorative serif, paper or "notebook" styling.

The week view is for quick scanning. Keep headlines short: the shape of the main set plus one key target. Keep the full shorthand out of it.

Charts:
- Zones use a single-hue blue ramp (`--z1`…`--z5` in `src/index.css`), validated as an ordinal palette for both light and dark. Don't swap in categorical colours.
- In the timeline, height encodes zone. Incline gets its own grey track.
- Text never takes a series colour.
- Support light and dark via `prefers-color-scheme`. Check mobile width (~390px) for horizontal overflow.

GAP and flat-equivalent distance use the Minetti (2002) polynomial. Label it as such. Don't invent other models' coefficients.

## Verifying changes

- **Logic:** add or extend vitest cases next to the code (`*.test.ts`).
- **UI:** run the dev server and drive it in a browser (e.g. Playwright with system Chrome). Check the entry form, the week table, and both colour schemes. Report console errors.
