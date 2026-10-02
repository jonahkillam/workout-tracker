begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

create function pg_temp.sign_in(uid text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;

-- The tables carry the data's structure.
select columns_are('public', 'workouts', array[
  'user_id', 'id', 'date', 'sport', 'title', 'notes', 'rpe', 'duration', 'raw_text', 'blocks', 'profile', 'speed_unit',
  'recording_id', 'recording_linked_by', 'recording_offset', 'unlinked_recording_id', 'created_at', 'updated_at',
  'deleted', 'client_ts', 'rev'], 'workouts has a column per field');
select col_type_is('public', 'workouts', 'date', 'date', 'workout date is a date');
select col_type_is('public', 'recordings', 'start_time', 'timestamp with time zone', 'recording start is a timestamptz');

-- User A pushes a workout and a note.
select pg_temp.sign_in('00000000-0000-0000-0000-00000000000a');
select is(
  public.sync_push('[
    {"table": "workouts", "key": "w1", "client_ts": 100, "row": {"id": "w1", "date": "2026-09-29", "sport": "run",
      "raw_text": "10m", "blocks": [], "created_at": "2026-09-29T07:00:00Z", "updated_at": "2026-09-29T07:00:00Z"}},
    {"table": "week_notes", "key": "2026-09-28", "client_ts": 100,
      "row": {"week_start": "2026-09-28", "text": "hi", "updated_at": "2026-09-29T07:00:00Z"}}
  ]'),
  '[]'::jsonb, 'push accepts new rows');
select is((select date from public.workouts where id = 'w1'), '2026-09-29'::date, 'fields land in their columns');
select results_eq(
  $$ select "table", key, "row" ->> 'raw_text' from public.sync_pull(0) $$,
  $$ values ('workouts', 'w1', '10m'), ('week_notes', '2026-09-28', null) $$,
  'pull returns rows in rev order, with their columns');

-- Last write wins on client_ts, and a change replaces the whole row.
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "client_ts": 50, "row": {"id": "w1", "date": "2026-01-01",
    "sport": "run", "raw_text": "old", "blocks": [], "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}}]'),
  '[{"key": "w1", "table": "workouts"}]'::jsonb, 'older change is rejected');
select is((select raw_text from public.workouts where id = 'w1'), '10m', 'older change left the row alone');
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "client_ts": 200, "row": {"id": "w1", "date": "2026-09-30",
    "sport": "ride", "raw_text": "new", "blocks": [], "created_at": "2026-09-29T07:00:00Z", "updated_at": "2026-09-30T07:00:00Z",
    "title": "Ride"}}]'),
  '[]'::jsonb, 'newer change is applied');
select is((select title || ' ' || raw_text from public.workouts where id = 'w1'), 'Ride new', 'newer change replaced the row');

-- The cursor only returns what changed since.
select is(
  (select count(*)::int from public.sync_pull((select rev from public.week_notes))), 1,
  'pull since a cursor returns only later changes');

-- Tombstones.
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "deleted": true, "row": {"title": "x"}, "client_ts": 300}]'),
  '[]'::jsonb, 'delete is applied');
select results_eq(
  $$ select deleted, "row" ->> 'raw_text', "row" ->> 'title' from public.sync_pull(0) where key = 'w1' $$,
  $$ values (true, null, null) $$,
  'pull returns the tombstone without its data');

-- Settings: one row per user. Far-future client clocks are clamped.
select public.sync_push('[{"table": "settings", "key": "settings", "client_ts": 99999999999999,
  "row": {"ftp": 250, "stair_step_height": 0.2, "stair_floor_height": 3.25, "speed_unit": "kmh"}}]');
select ok((select client_ts from public.settings) < 99999999999999, 'future client_ts is clamped');
select is((select ftp from public.settings), 250::double precision, 'settings has typed columns');

-- Templates sync like the other keyed tables.
select is(
  public.sync_push('[{"table": "templates", "key": "t1", "client_ts": 100, "row": {"id": "t1", "name": "Hill reps",
    "sport": "treadmill", "raw_text": "10x60/60 @ 12%", "updated_at": "2026-09-29T07:00:00Z"}}]'),
  '[]'::jsonb, 'push accepts a template');
select results_eq(
  $$ select "row" ->> 'name', "row" ->> 'raw_text' from public.sync_pull(0) where "table" = 'templates' $$,
  $$ values ('Hill reps', '10x60/60 @ 12%') $$,
  'pull returns the template');
select throws_ok(
  $$ select public.sync_push('[{"table": "templates", "key": "t2", "client_ts": 1, "row": {"id": "t2", "sport": "run"}}]') $$,
  '23514', null, 'push rejects a template missing required fields');

-- Bad input is refused rather than stored.
select throws_ok(
  $$ select public.sync_push('[{"table": "strava_tokens", "key": "x", "row": {}, "client_ts": 1}]') $$,
  '22023', null, 'push rejects tables outside the synced set');
select throws_ok(
  $$ select public.sync_push('[{"table": "week_notes", "key": "2026-10-05", "client_ts": 1,
    "row": {"week_start": "2026-10-05", "text": "x", "updated_at": "2026-10-05T00:00:00Z", "mood": "good"}}]') $$,
  '22023', null, 'push rejects a field the table has no column for');
select throws_ok(
  $$ select public.sync_push('[{"table": "workouts", "key": "w2", "client_ts": 1, "row": {"id": "w2", "sport": "run"}}]') $$,
  '23514', null, 'push rejects a workout missing required fields');

-- User B sees none of A's rows, and can't overwrite them.
select pg_temp.sign_in('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.sync_pull(0)), 0, 'other users see nothing');
select public.sync_push('[{"table": "workouts", "key": "w1", "client_ts": 999, "row": {"id": "w1", "date": "2026-09-29",
  "sport": "run", "raw_text": "mine", "blocks": [], "created_at": "2026-09-29T07:00:00Z", "updated_at": "2026-09-29T07:00:00Z"}}]');
select is((select count(*)::int from public.workouts where id = 'w1'), 1, 'B sees only their own w1');

-- Writes only go through sync_push; Strava tokens are service-role only.
select throws_ok($$ delete from public.workouts $$, '42501', null, 'users cannot write the tables directly');
select throws_ok($$ select * from public.strava_tokens $$, '42501', null, 'users cannot read Strava tokens');

select * from finish();
rollback;
