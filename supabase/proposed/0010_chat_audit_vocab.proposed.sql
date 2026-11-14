-- ============================================================================================
-- PROPOSED, NOT APPLIED. Widens the chat audit vocabulary (0008) so the assistant can record answers that came from organizational
-- knowledge: ONE new intent ('knowledge') and ONE new source id ('knowledge'), and room for the 13th source id in source_ids.
-- Depends on 0008 (public.chat_audit). It does NOT edit 0008, which is applied to the development project exactly as reviewed.
-- Additive only: every value that was valid before is still valid; no row is changed or removed; no privilege, policy or trigger
-- is touched. The table stays metadata-only: still no free-text column, still fixed vocabularies and bounded numbers.
-- Verified ONLY on a local PostgreSQL (supabase/proposed/tests/0009_knowledge.pglite.mjs). NOT run on any remote project.
--
-- WHY IT IS NEEDED: tests/chat-audit.test.ts requires the SQL vocabulary to equal the TypeScript unions, because an audit row with a
-- value the CHECK does not allow is refused by the database (the app logs it and carries on, but the audit row is lost). Apply this
-- BEFORE enabling knowledge answers on a Supabase backend, together with 0009.
--
-- HOW: the constraints are found by the column they check (their names are auto-generated), dropped and re-added under stable names
-- inside one transaction. Re-adding validates the existing rows against the wider check; the table is small and the lock is brief.
-- ============================================================================================

-- ---- run as postgres, then put the session back exactly as it was (see docs/SUPABASE_CLI_ROLE_MODEL.md) ----
select set_config('broko.prev_role', current_user, false);
set role postgres;

do $$
declare
  c text;
  intent_col smallint;
  source_col smallint;
begin
  select attnum into intent_col from pg_attribute where attrelid = 'public.chat_audit'::regclass and attname = 'intent' and not attisdropped;
  select attnum into source_col from pg_attribute where attrelid = 'public.chat_audit'::regclass and attname = 'source_ids' and not attisdropped;
  if intent_col is null or source_col is null then raise exception '0010 needs public.chat_audit from 0008'; end if;

  for c in select conname from pg_constraint where conrelid = 'public.chat_audit'::regclass and contype = 'c' and conkey = array[intent_col] loop
    execute format('alter table public.chat_audit drop constraint %I', c);
  end loop;
  for c in select conname from pg_constraint where conrelid = 'public.chat_audit'::regclass and contype = 'c' and conkey = array[source_col] loop
    execute format('alter table public.chat_audit drop constraint %I', c);
  end loop;
end $$;

alter table public.chat_audit add constraint chat_audit_intent_check
  check (intent in ('attention', 'pending_tasks', 'today', 'overdue', 'upcoming', 'priority', 'owners', 'notifications', 'ai_inbox',
                    'integrations', 'sources', 'summary', 'preconstruction', 'knowledge', 'action_request', 'blocked', 'clarify', 'unsupported', 'help'));
alter table public.chat_audit add constraint chat_audit_source_ids_check
  check (cardinality(source_ids) <= 13
         and source_ids <@ array['tasks', 'activity', 'notifications', 'ai_inbox', 'integrations', 'email', 'teams', 'whatsapp', 'calendar', 'crm', 'documents', 'preconstruction', 'knowledge']);

-- ROLLBACK (manual; refused while any row uses the new values): restore the 0008 lists by dropping the two constraints above and
-- adding back the ones in 0008_chat_audit.proposed.sql.

-- ---- restore the role this file started with ----
do $$ begin
  execute format('set role %I', current_setting('broko.prev_role'));
  perform set_config('broko.prev_role', '', false);
end $$;
