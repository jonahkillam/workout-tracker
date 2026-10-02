# AGENTS.md

A training log for running, treadmill (incline), stair climber and cycling workouts. Workouts are typed in a compact shorthand, parsed live, and summarised per week. The syntax and features are covered in `README.md`.

## Stack and commands

TypeScript + React 19 + Vite. The app reads and writes a local copy of the signed-in user's data in the browser (IndexedDB via Dexie) and syncs it with Supabase (Postgres, Auth), provisioned through the Vercel Marketplace integration. Sign-in is by a 6-digit code sent by email. The only server code is Strava token handling (`server/strava.ts`), served by the Vite dev/preview server locally and by a Vercel function (`api/strava/[action].ts`) when deployed. Node is pinned by `mise.toml`.

```
mise run db:start    # local Supabase (Docker); emails go to Mailpit, http://127.0.0.1:54424
mise run dev:local   # dev server against the local Supabase
mise run dev         # dev server with SUPABASE_* from .env.local (vercel env pull)
mise run check       # typecheck + lint (oxlint) + tests (vitest) — run before finishing
mise run db:test     # pgTAP tests in supabase/tests; db:reset re-applies migrations
mise run build       # production build
mise run preview:local  # build + serve against the local Supabase (has the service worker)
mise run test:watch
```

`npm run dev|build|test|lint` also work. There is no formatter config. Match the existing style: 2-space indent, single quotes, no semicolons, ~120-column lines.

## Layout

| Path | What |
|---|---|
| `src/model/types.ts` | Domain types: `Workout`, `Block` (`Step` \| `Repeat`), `Targets`, `Profile`, `Settings`, `Template`; `isPlanned` |
| `src/model/tree.ts` | Block tree helpers: `expand` (applies `skipLastRest`), `occurrences`, path edits, `withSpeedUnit` |
| `src/parser/tokenizer.ts`, `parser.ts` | Shorthand → `Block[]` + diagnostics + highlight spans |
| `src/parser/serialize.ts` | `Block[]` → canonical shorthand (used when the step table edits a workout) |
| `src/parser/summary.ts` | One-line main-set headline for the week view |
| `src/parser/format.ts` | Number, duration, pace and speed formatting |
| `src/metrics/workout.ts` | Per-step stats, zones, load, Minetti grade cost, GAP, workout totals |
| `src/metrics/week.ts`, `dates.ts` | Week summaries, acute:chronic ratio, ISO weeks, local-date helpers |
| `src/nav/link.ts` | Links to a week or workout (`/?week=<date>`, `/?workout=<id>`): one-shot query params, read on load and removed from the URL, which stays `/` |
| `src/sw/sw.js` | Service worker: caches the app shell so the app opens offline. `vite.config.ts` (`appShellWorker`) adds the file list and writes `/sw.js`; builds only |
| `src/db/db.ts` | Dexie schema (DB `training-log-sync`), save/import/export, `clearLocalData` |
| `src/supabase.ts`, `src/auth/` | Supabase client; `AuthGate` (sign-in, then the app for that user), `SignIn`, sign-out |
| `src/sync/` | Outbox middleware (`outbox.ts`), push/pull (`engine.ts`), object ↔ server row mapping (`rows.ts`) |
| `supabase/` | `config.toml` (auth settings, local ports), `migrations/`, `tests/` (pgTAP), email `templates/` |
| `src/strava/` | OAuth client (`auth.ts`), API reads (`api.ts`), response mapping (`map.ts`), week sync (`sync.ts`, `useWeekSync.ts`), streams on demand (`streams.ts`, `useStreams.ts`) |
| `src/export/intervals.ts` | `Block[]` → intervals.icu workout text and calendar event |
| `src/intervals/` | intervals.icu API client (`api.ts`), calendar reconcile (`sync.ts`, `useIntervalsSync.ts`) |
| `src/recordings/match.ts` | Recording ↔ workout auto-linking, `newLink` |
| `src/recordings/intervals.ts`, `autolog.ts`, `recorded.ts` | Structure detection, auto-logging, recorded summaries |
| `src/metrics/recorded.ts` | Totals from recorded data |
| `server/strava.ts`, `api/strava/[action].ts` | Token exchange, access tokens, revoke (holds the client secret; tokens in `strava_tokens`) |
| `src/ui/week/` | Main view: `WeekTable` (one row per session) and `WeekPanels` |
| `src/ui/entry/` | Workout editor: shorthand input, timeline, editable step table |
| `src/ui/charts/`, `tools/`, `settings/` | Charts, GAP calculator, settings dialog |
| `src/ui/common/` | Shared UI: `Modal`, commit-on-blur `CommitInput`, threshold fields, recording summary row, speed-unit toggle |

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
- **Dexie migrations:** never edit an existing `db.version(n)`. Add a new version with an `upgrade`. Synced documents also live on the server, where Dexie upgrades don't reach, so a shape change to `Workout`, `WeekNote`, `Settings`, `Recording` or `Template` also needs a migration for its server table and an entry in `src/sync/rows.ts` (which won't type-check until every field has one).
- **Sync:**
  - The UI and all logic read and write Dexie only. `sync/outbox.ts` (a DBCore middleware) records every write to `workouts`, `weekNotes`, `settings`, `recordings` and `templates` in `outbox`, in the same transaction. Push reads each key's current row; a missing row is a delete. Code that writes these tables needs no sync calls, but must not keep synced data anywhere else.
  - Writes that come from the server, and wiping local data, go through `withoutOutbox`. Code inside the middleware uses Dexie promise chains, not native `await` (it loses Dexie's transaction zone).
  - The server has a table per synced type (`workouts`, `week_notes`, `settings`, `recordings`, `templates`) with a column per field; lists and nested objects are jsonb. `sync/rows.ts` converts between these rows and the app's objects. Clients only read the tables; all writes go through `sync_push`, which refuses fields that have no column. It keeps the newest write by `client_ts` (clamped to now + 1 min). Deletes are tombstones. Pulls go by the `rev` cursor. Pushes a server rejects are re-fetched by key.
  - IDs that more than one device can create must be deterministic, so the devices converge on one row: Strava recordings are `strava-<activity id>`, auto-logged workouts `auto-<recording id>`.
  - `recordingStreams`, `stravaWeekFetch`, `stravaConnection` and `intervalsConnection` are per-device. A device without a recording's streams downloads them from Strava when it shows the recording (`useEnsureStreams`).
  - The local DB belongs to one user (`syncMeta.owner`). Signing in as someone else wipes it first; signing out wipes it.
  - Startup work that writes (summaries, auto-logging, Strava week sync) waits for `whenReady()`, the first pull.
- **Offline:** once signed in and loaded, the app must open and take edits with no connection.
  - The service worker caches only the same-origin app shell. It never handles `/api/` or other origins, and holds no data.
  - `AuthGate` opens the app for the local owner (`syncMeta.owner`) without waiting for the session (`userToOpen` in `auth/user.ts`). Only a real sign-out shows sign-in: offline, the Supabase client reports no session when it can't renew an expired one.
  - `syncNow` makes no requests while `navigator.onLine` is false, so `whenReady()` resolves at once; the `online` event retries.
- **A workout without a recording is planned** (`isPlanned`): "Planned" from today on, "Missed" once its day has passed. Planned workouts count for nothing in week totals, load or trends (`summarizeWeek` skips them).
  - A workout planned ahead of its date takes the current thresholds when a recording auto-links to it (`linkWeek`), since that is when it was done.
  - A `Template` holds only shorthand, sport and speed unit; the editor parses it when used.
- **intervals.icu export** sends planned workouts from today on to the user's intervals.icu calendar, from devices that have an API key.
  - The key is the user's own, typed into Settings and kept in `intervalsConnection` on that device. It is never synced, exported or put in the bundle. Calls go straight from the browser (CORS allowed).
  - Sync is a reconcile (`intervals/sync.ts`), not a queue: list the events, compare with the local workouts, send the difference. It must stay safe to repeat.
  - Only events whose `external_id` starts with `workout-tracker:` are ever updated or deleted. An event whose workout has its recording is left alone; one whose workout is gone is deleted.
  - It runs only after `whenReady()`: a device that hasn't pulled its workouts would delete their events.
  - intervals.icu has no nested repeats, incline, level, step rate or RPE. `export/intervals.ts` writes outer repeats out and puts the rest in the step's cue as words. Its step totals must match `expand(blocks)`.
- **Recordings are source-agnostic.** Strava is the only source so far. A `Recording` holds the summary and laps; its per-sample arrays live in `recordingStreams` as typed arrays. A workout links to at most one recording (`Workout.recording`), which also stores how its steps line up with the recording (`offset`).
  - Week totals (table rows, footer, panels) come from the recording for runs with a GAP histogram and rides with a power histogram (`sessionTotals` in `metrics/recorded.ts`). Unlinked recordings count as unstructured sessions (`recordedTotals`). Treadmill and stair workouts, the editor, the viewer and planned zones stay plan-based.
  - `Recording.recorded` holds the moving time, distance and GAP/power/HR histograms, computed once from the streams (`recordings/recorded.ts`). Histograms don't depend on thresholds; zone them with `w.profile ?? fallback`, or `Recording.profile` for unlinked ones.
  - Auto-logging only creates a workout when detection finds clear workout structure (`looksLikeWorkout` in `recordings/intervals.ts`). Other runs and rides are marked `Recording.unstructured` and stay unstructured activities.
  - Auto-linking never overrides a manual link, and never re-links a recording the user unlinked (`Workout.unlinked`).
- **Strava token boundary.** Only the code exchange, access-token requests and revoke go through `/api/strava/*`, because they need the client secret and Strava's token endpoint has no CORS. Data calls go straight from the browser to `https://www.strava.com/api/v3` (CORS allowed).
  - Tokens live only in `strava_tokens` (service role only; RLS with no policies). The browser gets short-lived access tokens from `/api/strava/token` and keeps them in memory. Every `/api/strava/*` call carries the user's Supabase access token.
  - Refresh tokens rotate: keep the newest. Refresh is single-flight across devices and server instances through a lease (`claim_strava_refresh`).
  - The client secret, Supabase secret/service-role key and Strava tokens never reach the bundle. `vite.config.ts` exposes only the Supabase URL and publishable key; don't add `SUPABASE_` to `envPrefix`.
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
- **Sync / SQL:** `src/sync/*.test.ts` run against `FakeRemote` (same rules as the SQL). Change `supabase/migrations` by adding a migration, and cover it in `supabase/tests`.
- **UI:** run `mise run dev:local` and drive it in a browser (e.g. Playwright with system Chrome). Sign in with the code from Mailpit. Check the entry form, the week table, and both colour schemes. Report console errors.
