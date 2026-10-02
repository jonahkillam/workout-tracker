-- Saved workouts to start new ones from. Synced like the other tables (see the sync schema migration).

create table public.templates (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  name text,
  sport text check (sport in ('run', 'treadmill', 'stair', 'ride', 'other')),
  -- The shorthand; the app parses it when the template is used.
  raw_text text,
  speed_unit text check (speed_unit in ('kmh', 'pace')),
  updated_at timestamptz,
  deleted boolean not null default false,
  client_ts bigint not null,
  rev bigint not null,
  primary key (user_id, id),
  check (deleted or (name is not null and sport is not null and raw_text is not null and updated_at is not null))
);

create index templates_rev on public.templates (user_id, rev);
create trigger set_sync_rev before insert or update on public.templates
  for each row execute function public.set_sync_rev();
alter table public.templates enable row level security;
-- Reads go through RLS; writes only through sync_push.
revoke all on public.templates from anon, authenticated;
grant select on public.templates to authenticated;
create policy "Owner reads" on public.templates for select to authenticated
  using ((select auth.uid()) = user_id);

-- sync_push and sync_pull as before, with templates added.
create or replace function public.sync_push(changes jsonb) returns jsonb
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
    key_column := case tbl
      when 'workouts' then 'id' when 'recordings' then 'id' when 'templates' then 'id' when 'week_notes' then 'week_start'
    end;
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

create or replace function public.sync_pull(since bigint, lim int default 500)
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
    union all
    select 'templates', t.id, to_jsonb(t) - '{user_id,deleted,client_ts,rev}'::text[], t.deleted, t.rev
    from public.templates t where t.user_id = auth.uid() and t.rev > since
  ) r
  order by rev
  limit lim
$$;
