# Training notebook

A running/cycling log that works offline and syncs to your account. Each week is one table: a row per session with its zone profile and notes, then per-sport and weekly totals, zones, load and 12-week trends. Workouts are typed in coach-style shorthand and parsed live. Vertical gain is first-class, including treadmill incline and stair climbers.

With [mise](https://mise.jdx.dev) (pins Node 24; tasks install dependencies as needed):

```
mise install         # Node
mise run db:start    # local Supabase in Docker (API on :54421, Mailpit on :54424)
mise run dev:local   # http://localhost:5173, against the local Supabase
mise run check       # typecheck + lint + tests
mise run db:test     # database tests (pgTAP)
mise run build       # production build into dist/
mise tasks           # list everything
```

Or with plain npm: `npm install && npm run dev`, `npm test`.

## Accounts and sync

Sign in with your email: the email has a 6-digit code to enter on the sign-in page. Locally, the emails land in Mailpit at <http://127.0.0.1:54424>.

The app keeps a copy of your data in the browser (IndexedDB), so it's fast and works offline, and syncs it with Supabase in the background. The toolbar shows when changes were last saved, or how many are waiting when offline. Signing out removes the data from that browser. Settings → Export JSON still makes a backup file.

**On a phone:** install it from the browser (Android Chrome: menu → Install app; iOS Safari: Share → Add to Home Screen). The installed app keeps its own data, so sign in there with the code; on iOS the email's link opens Safari instead.

Data from before accounts stays in the browser, separate from the account. Settings offers to download it, add it to your account, or delete it.

**Local Supabase:** `supabase/config.toml` holds the auth settings (redirect URLs, email template, code length) and `supabase/migrations` the schema. The ports are moved up by 100 from Supabase's defaults so they don't clash with other local projects. `mise run dev:local` reads the URL and keys from `supabase status`; `mise run dev` instead reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) and `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) from `.env.local`, which is what `vercel env pull` writes.

**Deployed:** Supabase is added through the Vercel Marketplace integration, which sets those variables on the Vercel project. Push the schema and auth settings with `supabase link` then `supabase db push` and `supabase config push`. Set a custom SMTP sender in Supabase; its built-in one sends only a few emails an hour.

## Shorthand

```
10m wu, 3x10x40/20 @ 15%, 8.3-8.8km/h//6.5-7km/h, 10m cd
```

| Syntax | Meaning |
|---|---|
| `10m` `40s` `1h5m` `1:30` | durations (`m` = minutes) |
| `2km` `800mtr` `1mi` `100fl` | distance, stair floors |
| `wu` `cd` `easy` `work` `rec` | step role |
| `25m pause` | time stopped: a gap in charts, left out of time, distance, zones and load |
| `5x3m/2m` | 5 × (3 min work / 2 min rest) |
| `3x10x40/20` | 3 sets × 10 reps × (40s / 20s); bare numbers in a pair are seconds |
| `6x800mtr w/ 90s`, `3x(…) r3m` | rest after each rep / set |
| `5x3m/2m -r` | drop the final rest (5 work, 4 rests) |
| `@ 15%` `8.5km/h` `4:30/km` `220w` `150bpm` `Z3` `rpe7` `70spm` `lvl8` | targets; ranges like `8.3-8.8km/h` |
| `a//b` | work//rest split, e.g. `15%//5%` |
| `-3%` | negative grade (downhill); ranges of grades must be non-negative |

When written once, incline and machine level apply to work and rest. Intensity targets (speed, power, HR, zone, RPE) apply to work only.

**Speeds.** Each entry has a speed unit, km/h or min/km. New entries default to the Settings preference, and the entry sheet has a toggle. A speed without a unit (`8.5`, `8.3-8.8//6.5-7`) is read in that unit and flagged with a note. `4:30` is always a pace. Switching the toggle rewrites the speeds in place, so their values don't change.

**Thresholds.** Threshold pace (min/km), FTP, threshold HR and max HR are set in Settings. None has a default: until threshold pace is set, speed-based zones fall back to step type and RPE. Each workout stores a copy of the values when it's logged (`Workout.profile`), so changing Settings later doesn't alter past zones. Workouts with no value recorded take the first one you set. A workout's own values can be edited from its form.

**GAP.** Grade-adjusted pace is the flat speed with the same energy cost, from the Minetti (2002) cost of running on a grade. The entry form shows the average GAP for the workout and the GAP of each step on an incline. The toolbar's GAP calculator converts both ways: treadmill speed + incline → flat pace, or target flat pace + incline → treadmill speed. It also shows a table of common inclines.

**Notes.** Each workout note has a category: Note, Fueling, Injury, Sleep/wellness or Gear. Add one per line in the entry form. The week table shows them labelled and clipped to two lines; the viewer shows them in full.

## Strava

When connected, the app pulls each week's Strava activities as you view it. It stores them as recordings (summary, laps and streams, including heart rate) and links each one to the workout it clearly matches: same day, compatible sport, closest duration. Activities with no workout show as unstructured activities, with recorded HR, pace or power, and a "Log as workout" link. You can link or unlink a recording from a workout's form.

**Totals from recordings.** Weekly totals for runs with recorded pace and rides with recorded power come from the recording, not the parsed steps. Unstructured activities count too. That covers moving time, distance, climb, time in zones and load. Recorded zones use grade-adjusted pace (Minetti 2002) against threshold pace for runs, or 30 s power against FTP for rides. Without that threshold they use HR against threshold HR, and without either, the planned zones (Z2 if there's no plan). A workout's own form still shows the plan's totals.

Outdoor runs and rides with no workout are logged automatically when they clearly look like a workout, with the structure detected from the recording: warm-up, reps, recoveries and cool-down.
- **What looks like a workout:** at least two separate efforts, clearly harder than the rest of the moving time. Reps split only by standing still (lights, a gate) count as one broken effort, unless they're regular (same distance or time, even recoveries), as on a track. A steady run, a single surge or fast finish, or a tempo broken up by stops stays an unstructured activity.
- **How reps are found:** deliberate laps are used when present. Otherwise changes in grade-adjusted pace (runs) or power (rides; speed is never used) are found in the stream and snapped to a nearby lap. Grade-adjusted pace keeps a slow climb from reading as recovery.
- **What counts as work:** work starts at Z3 of your threshold pace or FTP, or at a clear two-level split when those aren't set. It must also be clearly harder than the stretches either side (15% for runs, 25% for rides); otherwise the whole activity is steady.
- **Warm-up and cool-down:** only the first stretch can be a warm-up and only the last a cool-down, and only when clearly easier than the stretch beside it. Anything else outside the reps is steady.
- **Grade:** each step gets its average grade (net climb over distance) as an incline, e.g. `4x60/90 @ 6%//-12%, 4:10/km`, so climb and GAP are counted. Grades under 0.5% are left off.
- **Pauses:** stops of a minute or more, whether the timer was paused or you stood still, become `pause` steps, so the plan stays lined up with the recording. In a recovery, standing still is part of the rest unless it's longer than 5 minutes.
- **Grouping:** reps within 10 s of each other are grouped into a repeat, with a pace or power range, e.g. `10m wu @ 5:33/km, 6x800mtr/90s -r @ 3:18-3:22/km, 10m cd`.
- **Deleting:** a generated workout you delete stays deleted.
- **Re-detecting:** use "Detect intervals" in a workout's form.

Setup:
1. Create an API application at <https://www.strava.com/settings/api>. Set **Authorization Callback Domain** to `localhost`. A Strava app has one callback domain, so use a second app, or change it, for a deployed domain.
2. `cp .env.example .env.local` and fill in `VITE_STRAVA_CLIENT_ID`, `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`. `.env.local` is gitignored.
3. `mise run dev:local`, sign in, then Settings → **Connect Strava**.

The client secret and the Strava tokens never reach the browser. The code exchange, token refresh and revoke go through `POST /api/strava/*` (`server/strava.ts`), which keeps the tokens in Supabase (`strava_tokens`, readable only by the server). The browser asks it for a current access token and calls Strava's API directly with it. Connecting once connects every device signed in to the account. The Vite dev/preview server serves these routes locally.

**Vercel:** `api/strava/[action].ts` runs the same handler as a serverless function, and `vercel.json` sends other paths, including `/strava/callback`, to the app. Set the three Strava env vars in the Vercel project; `VITE_STRAVA_CLIENT_ID` is used at build time.

## Layout

- `src/parser`: tokenizer, recursive-descent parser (with diagnostics and highlight spans) and `serializeBlocks`, the canonical round-trip used when editing the step table.
- `src/metrics`:
  - Per-step stats: distance from speed × time, vertical gain from grade, and Minetti flat-equivalent distance.
  - Zones: taken from zone, RPE, power, HR or flat-equivalent pace; otherwise from the step role.
  - Load: session RPE × minutes, or zone-weighted when there is no RPE.
  - Week summaries and the acute:chronic ratio.
- `src/db`: Dexie schema, JSON export/import.
- `src/auth`, `src/sync`, `supabase`: sign-in, the outbox and sync engine, and the Postgres schema.
- `src/strava`, `src/recordings`, `server`, `api`: Strava OAuth, weekly sync, recording ↔ workout matching, token handling.
- `src/ui`: week table and panels, workout editor (shorthand input → zone timeline → editable step table), charts.
