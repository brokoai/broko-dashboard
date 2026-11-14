-- ============================================================================================
-- DRAFT, NOT APPLIED to any database (written 2026-11-02, Phase 2, local only). Do not run without the owner's explicit approval, and only on
-- broko-dev first. The number 0012 is tentative and not reserved.
-- Knowledge secret check: a DATABASE-level floor under the application's secret screen.
--   The application refuses knowledge that looks like it contains a credential (src/lib/knowledge/safety.ts, called from
--   src/lib/knowledge/service.ts). The database used to check length only, so a signed-in member who calls the API directly with the
--   publishable key skipped that screen and could store a credential in a proposal. After an administrator approved it, everyone could
--   read it. This file makes the database refuse the highest-signal credential formats itself.
-- Depends on 0009 (public.knowledge_items) and is meant to be applied after 0011. It does NOT edit 0009, 0010 or 0011.
-- Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0012_knowledge_secret_check.pglite.mjs). Not run on any remote project.
--
-- WHAT IT ENFORCES (a deliberately small, low-false-positive list; the application screen stays stricter):
--   private_key   -----BEGIN ... PRIVATE KEY-----
--   api_key_prefix  sk- / pk- / rk- followed by 16+ key characters
--   supabase_key  sb_secret_ / sb_publishable_ followed by 8+ key characters
--   jwt           eyJ... . ... . ... (three long segments)
--   aws_key       AKIA + 16 upper-case letters or digits
--   vcs_token     ghp_ / gho_ / ghu_ / ghs_ / github_pat_ + 20+ characters
--   slack_token   xoxb- / xoxa- / xoxp- / xoxr- / xoxs- + 10+ characters
-- Fields checked on INSERT, and on UPDATE of any of them: title, body, topic, source_ref and review_note (knowledge_items), and note
-- (knowledge_events, the history rows written by knowledge_review). Review notes are written only by knowledge_review(), administrators
-- only, but that function is SECURITY DEFINER and a trigger sees every path, so the screen lives on the tables. Invisible and control characters (zero-width
-- spaces, bidi controls) are REMOVED before matching, so a key cannot be hidden by splitting it with one.
-- The trigger fires for every role, including the table owner: there is no trusted-path bypass.
--
-- WHAT IT DOES NOT DO (stated honestly):
--   * It is a floor, not a detector. It does NOT catch "the password is ..." assignments, 40+ character hex strings, long opaque
--     tokens, US social security numbers or payment card numbers. Those need context or checksums and would produce false positives in
--     a database rule; the application screen still refuses them on the normal path, but a direct API insert can store them.
--   * It does not look at feedback (fixed vocabularies). Review notes ARE checked, with the same seven formats and nothing broader, so
--     ordinary administrative comments are not restricted. A refused note aborts the whole review: the item keeps its status.
--   * A refusal reports the pattern id only, never the text, so the error cannot echo the secret.
--   * It cannot remove a secret that is already stored; knowledge_redact() (0011) does that.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

-- ------------------------------------------------------------------ the detector
-- Returns the id of the first pattern that matches, or NULL. Pure and immutable. Boundaries are written with explicit ASCII classes
-- (not \y) so that "a letter before the key" means the same here as it does in the application's regular expressions.
create or replace function public.knowledge_secret_signal(p_text text) returns text
  language plpgsql immutable set search_path = ''
as $$
declare
  t text := pg_catalog.regexp_replace(coalesce(p_text, ''), '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]', '', 'g');
begin
  if t ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----' then return 'private_key'; end if;
  if t ~ '(^|[^A-Za-z0-9_])(sk|pk|rk)-[A-Za-z0-9_-]{16,}' then return 'api_key_prefix'; end if;
  if t ~ '(^|[^A-Za-z0-9_])sb_(secret|publishable)_[A-Za-z0-9_-]{8,}' then return 'supabase_key'; end if;
  if t ~ '(^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}' then return 'jwt'; end if;
  if t ~ '(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}($|[^A-Za-z0-9_])' then return 'aws_key'; end if;
  if t ~ '(^|[^A-Za-z0-9_])(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}' then return 'vcs_token'; end if;
  if t ~ '(^|[^A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{10,}' then return 'slack_token'; end if;
  return null;
end $$;
revoke all on function public.knowledge_secret_signal(text) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ the guard
-- SECURITY DEFINER with an empty search_path, like every other knowledge trigger function. No API role may execute it directly.
create or replace function public.knowledge_secret_guard() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  signal text := public.knowledge_secret_signal(pg_catalog.concat_ws(E'\n', new.title, new.body, new.topic, new.source_ref, new.review_note));
begin
  if signal is not null then
    -- The pattern id only. The text is never part of the message.
    raise exception 'knowledge text appears to contain a secret or credential (%)', signal
      using errcode = '23514', constraint = 'knowledge_no_secrets';
  end if;
  return new;
end $$;
revoke all on function public.knowledge_secret_guard() from public, anon, authenticated, service_role;

-- BEFORE the row is written, on insert and on any update of the four checked columns. Any refusal aborts the whole statement.
create or replace trigger knowledge_items_secret_guard
  before insert or update of title, body, topic, source_ref, review_note on public.knowledge_items
  for each row execute function public.knowledge_secret_guard();

-- The history table: its note column is copied from the review note by knowledge_review(), and knowledge_redact() sets it to null or to fixed text.
create or replace function public.knowledge_events_secret_guard() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  signal text := public.knowledge_secret_signal(new.note);
begin
  if signal is not null then
    raise exception 'knowledge text appears to contain a secret or credential (%)', signal
      using errcode = '23514', constraint = 'knowledge_no_secrets';
  end if;
  return new;
end $$;
revoke all on function public.knowledge_events_secret_guard() from public, anon, authenticated, service_role;

create or replace trigger knowledge_events_secret_guard
  before insert or update of note on public.knowledge_events
  for each row execute function public.knowledge_events_secret_guard();

-- ROLLBACK (manual; nothing is lost because the trigger only refuses writes):
--   drop trigger knowledge_events_secret_guard on public.knowledge_events;
--   drop function public.knowledge_events_secret_guard();
--   drop trigger knowledge_items_secret_guard on public.knowledge_items;
--   drop function public.knowledge_secret_guard();
--   drop function public.knowledge_secret_signal(text);

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
