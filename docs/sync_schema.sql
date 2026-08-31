-- =====================================================================
-- schedule-hub device sync -- Supabase migration
--
-- PURELY ADDITIVE. It creates one new table and two new functions and
-- touches nothing that already exists in this project. There is no DROP,
-- no ALTER of an existing object, and no change to any existing grant.
--
-- THE THREAT MODEL
-- The app is served from a public GitHub Pages origin, so the anon key in
-- sync.js is world-readable. The anon key is therefore NOT a secret and
-- cannot be the thing that protects the data. The sync code is.
--
-- So: RLS is enabled on the table and the table has NO policies at all,
-- and every table privilege is revoked from anon and authenticated. That
-- means anon cannot SELECT, INSERT, UPDATE or DELETE a single row through
-- PostgREST no matter what it asks for -- not "sees zero rows because a
-- policy filtered them", but "has no privilege on the relation". A policy
-- bug cannot leak anything because there are no policies to get wrong.
--
-- The only door is two SECURITY DEFINER functions that take the sync code
-- as an argument. They hash it server-side and only ever touch rows whose
-- room_hash matches. Neither function can be asked for a list of rooms,
-- neither returns room_hash, and neither reports whether a room exists --
-- a wrong code and an empty room both return zero rows, so there is no
-- oracle to enumerate against.
--
-- WHAT THIS PROTECTS AGAINST
--   * Anon key alone: reads nothing, writes nothing, enumerates nothing.
--   * Row enumeration / scraping the table: impossible without a code.
--   * A leak of the sync code itself out of the database: the code is
--     stored only as a SHA-256 hash, never in plaintext.
--   * Guessing a code: the client generates 26 base32 chars (~130 bits),
--     and push/pull reject anything under 20 characters so a short code
--     can never be probed at all.
--
-- WHAT THIS DOES NOT PROTECT AGAINST
--   * The sync code is a bearer secret. Anyone who has it has full read
--     and write on that room, including deleting everything in it. There
--     is no second factor and no per-device revocation -- rotating means
--     generating a new code and re-entering it on every device.
--   * The synced rows are stored in plaintext JSON. This is not end-to-end
--     encryption: anyone with the project's service key or dashboard
--     access (Jack, and anyone who compromises that) can read the notes,
--     blocks and grades. Only the code itself is hidden from them.
--   * Rate limiting is whatever Supabase applies at the edge; there is no
--     per-code throttle in the database.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The table. One row per synced item, per room.
-- ---------------------------------------------------------------------
create table if not exists public.schedhub_sync (
  room_hash  text    not null,   -- sha256(sync code), hex. never returned.
  item_key   text    not null,   -- "<namespace>:<id>", e.g. "plan:blk_7fa"
  value      jsonb,              -- null when deleted
  deleted    boolean not null default false,
  updated_at bigint  not null,   -- client clock, ms since epoch, per item
  server_at  timestamptz not null default now(),
  primary key (room_hash, item_key)
);

-- Pull asks for "everything in this room changed since X".
create index if not exists schedhub_sync_room_updated
  on public.schedhub_sync (room_hash, updated_at);

-- ---------------------------------------------------------------------
-- 2. Lock the table itself away from every client role.
--    RLS on + zero policies = deny all. The REVOKEs mean even a future
--    accidental policy still would not hand anon a privilege.
-- ---------------------------------------------------------------------
alter table public.schedhub_sync enable row level security;
alter table public.schedhub_sync force row level security;

revoke all on public.schedhub_sync from anon;
revoke all on public.schedhub_sync from authenticated;

-- ---------------------------------------------------------------------
-- 3. The only door in: two SECURITY DEFINER functions.
--    search_path is pinned so a caller cannot shadow a name into them.
-- ---------------------------------------------------------------------

-- Hash a code. Uses the built-in sha256() (Postgres 11+), so this needs
-- no extension. Rejects short codes outright: a code that can be guessed
-- is not a credential, and refusing here means no brute-force surface.
create or replace function public.schedhub_room(p_code text)
returns text
language plpgsql
immutable
as $$
begin
  if p_code is null or length(btrim(p_code)) < 20 then
    raise exception 'sync code too short';
  end if;
  return encode(sha256(convert_to(btrim(p_code), 'UTF8')), 'hex');
end;
$$;

-- PULL. Returns the room's items changed at or after p_since.
-- Never returns room_hash. Wrong code => zero rows, same as empty room.
create or replace function public.schedhub_pull(p_code text, p_since bigint default 0)
returns table (item_key text, value jsonb, deleted boolean, updated_at bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h text := public.schedhub_room(p_code);
begin
  return query
    select s.item_key, s.value, s.deleted, s.updated_at
      from public.schedhub_sync s
     where s.room_hash = h
       and s.updated_at >= coalesce(p_since, 0)
     order by s.updated_at asc
     limit 20000;
end;
$$;

-- PUSH. p_items is a JSON array of
--   {"k": "<item_key>", "v": <any json or null>, "d": <bool>, "t": <ms>}
-- Last write wins PER ITEM: an incoming row only replaces the stored one
-- when its own updated_at is strictly newer. Pushing block X therefore
-- cannot touch block Y, which is the whole point -- editing on the phone
-- must never roll back something added on the laptop.
-- Returns the number of rows actually written.
create or replace function public.schedhub_push(p_code text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h text := public.schedhub_room(p_code);
  n integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return 0;
  end if;
  if jsonb_array_length(p_items) > 2000 then
    raise exception 'too many items in one push';
  end if;

  with incoming as (
    select
      (e->>'k')::text                        as item_key,
      case when e->>'v' is null then null else e->'v' end as value,
      coalesce((e->>'d')::boolean, false)    as deleted,
      (e->>'t')::bigint                      as updated_at
    from jsonb_array_elements(p_items) e
    where e->>'k' is not null
      and (e->>'t') ~ '^[0-9]+$'
      and length(e->>'k') between 1 and 400
  ),
  ins as (
    insert into public.schedhub_sync
      (room_hash, item_key, value, deleted, updated_at, server_at)
    select h, i.item_key, i.value, i.deleted, i.updated_at, now()
      from incoming i
    on conflict (room_hash, item_key) do update
      set value      = excluded.value,
          deleted    = excluded.deleted,
          updated_at = excluded.updated_at,
          server_at  = now()
      where excluded.updated_at > public.schedhub_sync.updated_at
    returning 1
  )
  select count(*)::integer into n from ins;

  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Grant the door, and only the door.
--    Note there is deliberately no grant on schedhub_room to anon: it is
--    an internal helper, and handing anon a code->hash oracle is free
--    help for anyone trying to precompute.
-- ---------------------------------------------------------------------
-- Supabase's default privileges hand anon EXECUTE on every new function in
-- public, so revoking from PUBLIC alone is not enough -- the explicit anon
-- and authenticated grants have to come off by name as well.
revoke all on function public.schedhub_pull(text, bigint) from public, anon, authenticated;
revoke all on function public.schedhub_push(text, jsonb)  from public, anon, authenticated;
revoke all on function public.schedhub_room(text)         from public, anon, authenticated;

grant execute on function public.schedhub_pull(text, bigint) to anon, authenticated;
grant execute on function public.schedhub_push(text, jsonb)  to anon, authenticated;
