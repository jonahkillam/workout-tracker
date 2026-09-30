-- Synced copies of the browser's Dexie tables. Each row holds one domain object as `doc`, keyed by its Dexie
-- primary key. The app's logic stays in the browser, so the server only stores, orders and merges documents.
--
-- Deletes are tombstones (`deleted`, `doc` null) so other devices learn about them. Every write takes the next
-- value of `sync_rev`, which is the cursor clients pull from. Conflicts are last-write-wins on `client_ts`.

create sequence public.sync_rev;

create function public.set_sync_rev() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.rev := nextval('public.sync_rev');
  new.updated_at := now();
  return new;
end
$$;

create table public.workouts (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  doc jsonb,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  date text generated always as (doc ->> 'date') stored,
  sport text generated always as (doc ->> 'sport') stored,
  primary key (user_id, key)
);

create table public.week_notes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  doc jsonb,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.settings (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  doc jsonb,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.recordings (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  doc jsonb,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  local_date text generated always as (doc ->> 'localDate') stored,
  strava_id bigint generated always as ((doc ->> 'stravaId')::bigint) stored,
  primary key (user_id, key)
);

create index recordings_strava_id on public.recordings (user_id, strava_id);

grant usage on sequence public.sync_rev to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['workouts', 'week_notes', 'settings', 'recordings'] loop
    execute format('create index %I on public.%I (user_id, rev)', t || '_rev', t);
    execute format('create trigger set_sync_rev before insert or update on public.%I
      for each row execute function public.set_sync_rev()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    -- No delete policy: deletes are tombstones.
    execute format('create policy "Owner reads" on public.%I for select to authenticated
      using ((select auth.uid()) = user_id)', t);
    execute format('create policy "Owner inserts" on public.%I for insert to authenticated
      with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "Owner updates" on public.%I for update to authenticated
      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
  end loop;
end
$$;

-- Applies a batch of local changes: [{table, key, doc, deleted, client_ts}]. A change is applied unless the
-- server's copy is newer. Returns the changes that were not applied, as [{table, key}].
create function public.sync_push(changes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid := auth.uid();
  -- Client clocks can run ahead; don't let one row win every future conflict.
  max_ts bigint := (extract(epoch from now()) * 1000)::bigint + 60000;
  c jsonb;
  is_deleted boolean;
  n int;
  rejected jsonb := '[]';
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  -- One push per user at a time, so each user's revs commit in order and a pull never skips past an
  -- uncommitted lower rev.
  perform pg_advisory_xact_lock(hashtext(uid::text));
  for c in select * from jsonb_array_elements(changes) loop
    if c ->> 'table' is null or c ->> 'table' not in ('workouts', 'week_notes', 'settings', 'recordings') then
      raise exception 'Unknown table %', c ->> 'table';
    end if;
    is_deleted := coalesce((c ->> 'deleted')::boolean, false);
    execute format($q$
      insert into public.%I as t (user_id, key, doc, deleted, client_ts)
      values ($1, $2, $3, $4, $5)
      on conflict (user_id, key) do update
        set doc = excluded.doc, deleted = excluded.deleted, client_ts = excluded.client_ts
        where t.client_ts <= excluded.client_ts
    $q$, c ->> 'table')
    using uid, c ->> 'key', case when is_deleted then null else c -> 'doc' end, is_deleted,
      least((c ->> 'client_ts')::bigint, max_ts);
    get diagnostics n = row_count;
    if n = 0 then
      rejected := rejected || jsonb_build_object('table', c ->> 'table', 'key', c ->> 'key');
    end if;
  end loop;
  return rejected;
end
$$;

-- Everything the caller has changed since `since`, tombstones included, in rev order.
create function public.sync_pull(since bigint, lim int default 500)
returns table ("table" text, key text, doc jsonb, deleted boolean, rev bigint)
language sql stable security invoker set search_path = '' as $$
  select * from (
    select 'workouts', key, doc, deleted, rev from public.workouts where user_id = auth.uid() and rev > since
    union all
    select 'week_notes', key, doc, deleted, rev from public.week_notes where user_id = auth.uid() and rev > since
    union all
    select 'settings', key, doc, deleted, rev from public.settings where user_id = auth.uid() and rev > since
    union all
    select 'recordings', key, doc, deleted, rev from public.recordings where user_id = auth.uid() and rev > since
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

-- Recording streams: one gzipped object per recording at {user_id}/{recording_id}.bin.
insert into storage.buckets (id, name, public) values ('streams', 'streams', false) on conflict (id) do nothing;

create policy "Owner reads streams" on storage.objects for select to authenticated
  using (bucket_id = 'streams' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner writes streams" on storage.objects for insert to authenticated
  with check (bucket_id = 'streams' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner updates streams" on storage.objects for update to authenticated
  using (bucket_id = 'streams' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'streams' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owner deletes streams" on storage.objects for delete to authenticated
  using (bucket_id = 'streams' and (storage.foldername(name))[1] = (select auth.uid())::text);
