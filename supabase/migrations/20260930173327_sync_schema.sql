-- Synced copies of the browser's Dexie tables, one table each, with a column per field. Lists and nested objects
-- (a workout's blocks and notes, a recording's laps, threshold snapshots) are jsonb. The app's logic stays in the
-- browser, so the server only stores, orders and merges rows; `src/sync/rows.ts` converts between these rows and
-- the app's objects.
--
-- Every table also has the sync columns: deletes are tombstones (`deleted`, with the data columns null) so other
-- devices learn about them; `client_ts` is when the device made the change, and the newest one wins; every write
-- takes the next value of `sync_rev`, which is the cursor clients pull from.

create sequence public.sync_rev;

create function public.set_sync_rev() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.rev := nextval('public.sync_rev');
  return new;
end
$$;

create table public.workouts (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  date date,
  sport text check (sport in ('run', 'treadmill', 'stair', 'ride', 'other')),
  title text,
  -- [{kind, text}]
  notes jsonb,
  rpe double precision,
  -- Seconds, for sessions without structure.
  duration double precision,
  -- The shorthand as typed; `blocks` is what it parsed to.
  raw_text text,
  blocks jsonb,
  -- Thresholds when it was logged: {thresholdSpeed, ftp, lthr, maxHr, stairStepHeight, stairFloorHeight}.
  profile jsonb,
  speed_unit text check (speed_unit in ('kmh', 'pace')),
  -- The linked recording. Not a foreign key: devices push the two in any order.
  recording_id text,
  recording_linked_by text check (recording_linked_by in ('auto', 'manual')),
  -- Seconds into the recording where step 1 starts.
  recording_offset double precision,
  -- A recording the user unlinked, so it isn't linked again automatically.
  unlinked_recording_id text,
  created_at timestamptz,
  updated_at timestamptz,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  primary key (user_id, id),
  check (deleted or (date is not null and sport is not null and raw_text is not null and blocks is not null
    and created_at is not null and updated_at is not null)),
  check ((recording_id is null) = (recording_linked_by is null))
);

create table public.week_notes (
  user_id uuid not null references auth.users on delete cascade,
  -- The Monday starting the week.
  week_start date not null,
  text text,
  updated_at timestamptz,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  primary key (user_id, week_start),
  check (deleted or (text is not null and updated_at is not null))
);

-- One row per user.
create table public.settings (
  user_id uuid primary key references auth.users on delete cascade,
  -- km/h on the flat.
  threshold_speed double precision,
  -- W.
  ftp double precision,
  -- bpm.
  lthr double precision,
  max_hr double precision,
  -- Metres.
  stair_step_height double precision,
  stair_floor_height double precision,
  speed_unit text check (speed_unit in ('kmh', 'pace')),
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  check (deleted or (stair_step_height is not null and stair_floor_height is not null and speed_unit is not null))
);

create table public.recordings (
  user_id uuid not null references auth.users on delete cascade,
  -- strava-<activity id>
  id text not null,
  strava_id bigint,
  -- Streams and laps were fetched, or found not to exist (`no_streams`).
  details_fetched boolean,
  no_streams boolean,
  start_time timestamptz,
  -- The calendar date where it was recorded.
  local_date date,
  sport text check (sport in ('run', 'treadmill', 'stair', 'ride', 'other')),
  -- The sport as the source named it.
  raw_sport text,
  name text,
  -- Seconds.
  elapsed double precision,
  moving double precision,
  -- Metres.
  distance double precision,
  elevation_gain double precision,
  avg_hr double precision,
  max_hr double precision,
  -- [{start, duration, distance}], seconds from the start and metres.
  laps jsonb,
  auto_logged boolean,
  unstructured boolean,
  -- Totals and time-in-intensity histograms from the streams: {moving, distance, gap, power, hr}.
  recorded jsonb,
  -- Thresholds when `recorded` was worked out.
  profile jsonb,
  updated_at timestamptz,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  primary key (user_id, id),
  check (deleted or (start_time is not null and local_date is not null and sport is not null
    and raw_sport is not null and elapsed is not null and laps is not null and updated_at is not null))
);

do $$
declare
  t text;
begin
  foreach t in array array['workouts', 'week_notes', 'settings', 'recordings'] loop
    execute format('create index %I on public.%I (user_id, rev)', t || '_rev', t);
    execute format('create trigger set_sync_rev before insert or update on public.%I
      for each row execute function public.set_sync_rev()', t);
    execute format('alter table public.%I enable row level security', t);
    -- Reads go through RLS; writes only through sync_push.
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy "Owner reads" on public.%I for select to authenticated
      using ((select auth.uid()) = user_id)', t);
  end loop;
end
$$;

-- Applies a batch of local changes: [{table, key, row, deleted, client_ts}], where `row` holds the data columns
-- of that table. A change is applied unless the server's copy is newer. Returns the changes that were not
-- applied, as [{table, key}].
create function public.sync_push(changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  -- Client clocks can run ahead; don't let one row win every future conflict.
  max_ts bigint := (extract(epoch from now()) * 1000)::bigint + 60000;
  c jsonb;
  tbl text;
  key_column text;
  match text;
  is_deleted boolean;
  ts bigint;
  new_row jsonb;
  unknown text;
  newer boolean;
  rejected jsonb := '[]';
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  -- One push per user at a time, so each user's revs commit in order and a pull never skips past an
  -- uncommitted lower rev.
  perform pg_advisory_xact_lock(hashtext(uid::text));
  for c in select * from jsonb_array_elements(changes) loop
    tbl := c ->> 'table';
    -- Settings has one row per user; the other tables are keyed by the object's key.
    key_column := case tbl when 'workouts' then 'id' when 'recordings' then 'id' when 'week_notes' then 'week_start' end;
    if key_column is null and tbl is distinct from 'settings' then
      raise exception 'Unknown table %', tbl using errcode = '22023';
    end if;
    match := 'user_id = $1' || case when key_column is null then '' else format(' and %I::text = $2', key_column) end;
    is_deleted := coalesce((c ->> 'deleted')::boolean, false);
    ts := least((c ->> 'client_ts')::bigint, max_ts);

    new_row := case when is_deleted then '{}' else coalesce(c -> 'row', '{}') end;
    -- A field the table has no column for would be dropped without a word, so refuse it.
    select string_agg(k, ', ') into unknown from jsonb_object_keys(new_row) k
    where not exists (
      select 1 from pg_attribute
      where attrelid = format('public.%I', tbl)::regclass and attname = k and attnum > 0 and not attisdropped
    );
    if unknown is not null then
      raise exception 'No % column for %', tbl, unknown using errcode = '22023';
    end if;
    new_row := new_row || jsonb_build_object('user_id', uid, 'deleted', is_deleted, 'client_ts', ts);
    if key_column is not null then
      new_row := new_row || jsonb_build_object(key_column, c ->> 'key');
    end if;

    execute format('select exists (select 1 from public.%I where %s and client_ts > $3)', tbl, match)
      into newer using uid, c ->> 'key', ts;
    if newer then
      rejected := rejected || jsonb_build_object('table', tbl, 'key', c ->> 'key');
      continue;
    end if;
    -- Replaces the whole row, so fields the change leaves out are cleared.
    execute format('delete from public.%I where %s', tbl, match) using uid, c ->> 'key';
    execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', tbl, tbl)
      using new_row;
  end loop;
  return rejected;
end
$$;

-- Everything the caller has changed since `since`, tombstones included, in rev order. `row` holds the table's
-- columns other than the sync ones.
create function public.sync_pull(since bigint, lim int default 500)
returns table ("table" text, key text, "row" jsonb, deleted boolean, rev bigint)
language sql stable security invoker set search_path = '' as $$
  select * from (
    select 'workouts', t.id, to_jsonb(t) - '{user_id,deleted,client_ts,rev}'::text[], t.deleted, t.rev
    from public.workouts t where t.user_id = auth.uid() and t.rev > since
    union all
    select 'week_notes', t.week_start::text, to_jsonb(t) - '{user_id,deleted,client_ts,rev}'::text[], t.deleted, t.rev
    from public.week_notes t where t.user_id = auth.uid() and t.rev > since
    union all
    select 'settings', 'settings', to_jsonb(t) - '{user_id,deleted,client_ts,rev}'::text[], t.deleted, t.rev
    from public.settings t where t.user_id = auth.uid() and t.rev > since
    union all
    select 'recordings', t.id, to_jsonb(t) - '{user_id,deleted,client_ts,rev}'::text[], t.deleted, t.rev
    from public.recordings t where t.user_id = auth.uid() and t.rev > since
  ) r
  order by rev
  limit lim
$$;

revoke execute on function public.sync_push(jsonb), public.sync_pull(bigint, int) from public, anon;
grant execute on function public.sync_push(jsonb), public.sync_pull(bigint, int) to authenticated;

-- Strava. Refresh tokens rotate, so one copy lives here and every device asks the server for access tokens.
-- Only the service role (the /api/strava functions) touches the tokens.
create table public.strava_tokens (
  user_id uuid primary key references auth.users on delete cascade,
  access_token text not null,
  refresh_token text not null,
  -- Epoch seconds, as Strava sends it.
  expires_at bigint not null,
  -- Set while one request refreshes, so concurrent ones wait instead of using a rotated refresh token.
  refresh_lease_until timestamptz
);

alter table public.strava_tokens enable row level security;
revoke all on public.strava_tokens from anon, authenticated;

create table public.strava_accounts (
  user_id uuid primary key references auth.users on delete cascade,
  athlete_id bigint not null,
  athlete_name text,
  scope text not null,
  connected_at timestamptz not null default now()
);

alter table public.strava_accounts enable row level security;
revoke all on public.strava_accounts from anon, authenticated;
grant select on public.strava_accounts to authenticated;
create policy "Owner reads" on public.strava_accounts for select to authenticated
  using ((select auth.uid()) = user_id);

-- Takes the refresh lease for a user. True if this caller should refresh.
create function public.claim_strava_refresh(uid uuid) returns boolean
language sql set search_path = '' as $$
  with claimed as (
    update public.strava_tokens set refresh_lease_until = now() + interval '20 seconds'
    where user_id = uid and (refresh_lease_until is null or refresh_lease_until < now())
    returning 1
  )
  select exists (select 1 from claimed)
$$;

revoke execute on function public.claim_strava_refresh(uuid) from public, anon, authenticated;
grant execute on function public.claim_strava_refresh(uuid) to service_role;
