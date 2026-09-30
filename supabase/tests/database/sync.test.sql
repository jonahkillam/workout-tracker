begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

create function pg_temp.sign_in(uid text) returns void language sql as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;

-- User A pushes a workout and a note.
select pg_temp.sign_in('00000000-0000-0000-0000-00000000000a');
select is(
  public.sync_push('[
    {"table": "workouts", "key": "w1", "doc": {"id": "w1", "date": "2026-09-29", "sport": "run"}, "client_ts": 100},
    {"table": "week_notes", "key": "2026-09-28", "doc": {"weekStart": "2026-09-28", "text": "hi"}, "client_ts": 100}
  ]'),
  '[]'::jsonb, 'push accepts new rows');
select results_eq(
  $$ select "table", key from public.sync_pull(0) $$,
  $$ values ('workouts', 'w1'), ('week_notes', '2026-09-28') $$,
  'pull returns rows in rev order');
select is((select date from public.workouts where key = 'w1'), '2026-09-29', 'generated date column');

-- Last write wins on client_ts.
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "doc": {"id": "w1", "v": "old"}, "client_ts": 50}]'),
  '[{"key": "w1", "table": "workouts"}]'::jsonb, 'older change is rejected');
select is((select doc ->> 'sport' from public.workouts where key = 'w1'), 'run', 'older change left the row alone');
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "doc": {"id": "w1", "v": "new"}, "client_ts": 200}]'),
  '[]'::jsonb, 'newer change is applied');
select is((select doc ->> 'v' from public.workouts where key = 'w1'), 'new', 'newer change replaced the doc');

-- The cursor only returns what changed since.
select is(
  (select count(*)::int from public.sync_pull((select max(rev) from public.week_notes))),
  1, 'pull since a cursor returns only later changes');

-- Tombstones.
select is(
  public.sync_push('[{"table": "workouts", "key": "w1", "deleted": true, "doc": {"x": 1}, "client_ts": 300}]'),
  '[]'::jsonb, 'delete is applied');
select results_eq(
  $$ select deleted, doc from public.sync_pull(0) where key = 'w1' $$,
  $$ values (true, null::jsonb) $$,
  'pull returns the tombstone without its doc');

-- Far-future client clocks are clamped.
select public.sync_push('[{"table": "settings", "key": "settings", "doc": {}, "client_ts": 99999999999999}]');
select ok(
  (select client_ts from public.settings where key = 'settings') < 99999999999999, 'future client_ts is clamped');

select throws_ok(
  $$ select public.sync_push('[{"table": "strava_tokens", "key": "x", "doc": {}, "client_ts": 1}]') $$,
  'P0001', 'Unknown table strava_tokens', 'push rejects tables outside the synced set');

-- User B sees none of A's rows, and can't overwrite them.
select pg_temp.sign_in('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.sync_pull(0)), 0, 'other users see nothing');
select public.sync_push('[{"table": "workouts", "key": "w1", "doc": {"mine": true}, "client_ts": 999}]');
select is((select count(*)::int from public.workouts where key = 'w1'), 1, 'same key for another user is a separate row');

-- Strava tokens are service-role only.
select throws_ok($$ select * from public.strava_tokens $$, '42501', null, 'users cannot read Strava tokens');

reset role;
select is((select count(*)::int from public.workouts where key = 'w1'), 2, 'each user has their own w1');

select * from finish();
rollback;
