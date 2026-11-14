import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeRepo } from "@/lib/knowledge/repo";
import type { FeedbackInput, KnowledgeEvent, KnowledgeInput, KnowledgeItem, ReviewAction, ReviewFilter } from "@/lib/knowledge/types";
import type { Profile } from "@/lib/types";
import { UserFacingError } from "../types";

// STATUS (2026-10-31): migrations 0009 and 0010 ARE applied to the development project broko-dev (history rows 0009 "knowledge" and
// 0010 "chat_audit_vocab"; their catalog audit passes). This adapter has NOT yet been exercised against it with real sessions: only a
// stub contract test (tests/knowledge-supabase-contract.test.ts) has run. Migration 0011 is a draft and is NOT applied.
// Every query runs as the signed-in user, so row level security from supabase/proposed/0009_knowledge.proposed.sql does the filtering
// and the review function does the status changes; this file only chooses columns. Columns are listed explicitly (never `*`).
// Requires 0009 (and 0010 for the audit vocabulary).

const ITEM_COLS =
  "id, kind, scope, project_id, title, body, topic, status, author_id, source_type, source_ref, supersedes_id, effective_from, expires_at, created_at, updated_at, reviewed_by, reviewed_at, review_note, author:profiles!knowledge_items_author_id_fkey(full_name), reviewer:profiles!knowledge_items_reviewed_by_fkey(full_name)";
const EVENT_COLS = "id, item_id, actor_id, action, from_status, to_status, note, created_at, actor:profiles!knowledge_events_actor_id_fkey(full_name)";
const MAX_ROWS = 200;

type ItemRow = Omit<KnowledgeItem, "author_name" | "reviewer_name"> & { author: { full_name: string } | null; reviewer: { full_name: string } | null };
type EventRow = Omit<KnowledgeEvent, "actor_name"> & { actor: { full_name: string } | null };

const toItem = ({ author, reviewer, ...r }: ItemRow): KnowledgeItem => ({ ...r, author_name: author?.full_name ?? null, reviewer_name: reviewer?.full_name ?? null });
const toEvent = ({ actor, ...r }: EventRow): KnowledgeEvent => ({ ...r, actor_name: actor?.full_name ?? null });

/** Maps database errors to messages a person can act on. Anything unrecognised becomes a generic Error (never shown verbatim). */
function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  const e = res.error;
  if (e) {
    switch (e.code) {
      case "42501": throw new UserFacingError("You do not have permission to do that.");
      case "54000": throw new UserFacingError("You are doing that too quickly. Please wait a minute and try again.");
      case "23514":
        // Raised by knowledge_review() once draft migration 0011 is applied: a replacement must match the scope, project and topic it replaces.
        if (e.message.includes("same scope, project and topic")) throw new UserFacingError("A replacement must apply to the same scope, project and topic as the item it replaces.");
        // Raised by the secret-check trigger in draft migration 0012. The message carries the pattern id only; it is not shown.
        if (e.message.includes("secret or credential")) throw new UserFacingError("This looks like it contains a password, key or other secret. Remove it and try again.");
        throw new UserFacingError("That does not meet the rules for knowledge items. Check the title, text, scope, project and topic.");
      case "55000": throw new UserFacingError("That item is not in a state where this can be done. Reload the page and try again.");
      case "22023": throw new UserFacingError("Please give a reason.");
      case "P0002": throw new UserFacingError("That item was not found.");
      case "23503": throw new UserFacingError("That project or item was not found.");
      default: throw new Error(e.message);
    }
  }
  return res.data as T;
}

export function createSupabaseKnowledgeRepo(db: SupabaseClient, user: Profile): KnowledgeRepo {
  const isAdmin = user.role === "admin";
  const items = () => db.from("knowledge_items");

  async function one(id: string): Promise<KnowledgeItem | null> {
    const row = check(await items().select(ITEM_COLS).eq("id", id).maybeSingle()) as unknown as ItemRow | null;
    return row ? toItem(row) : null;
  }
  const many = (rows: unknown) => ((rows ?? []) as ItemRow[]).map(toItem);
  const count = async (rating: "useful" | "not_useful") => {
    const { count: n, error } = await db.from("answer_feedback").select("id", { count: "exact", head: true }).eq("rating", rating);
    if (error) throw new Error(error.message);
    return n ?? 0;
  };

  return {
    writable: true,

    async listCurrent() {
      const now = new Date().toISOString();
      // RLS already hides anything else from members; the filters make the same rule explicit for administrators, who can read everything.
      const rows = check(await items().select(ITEM_COLS).eq("status", "approved").lte("effective_from", now).or(`expires_at.is.null,expires_at.gt.${now}`)
        .order("updated_at", { ascending: false }).limit(MAX_ROWS));
      return many(rows);
    },
    async listMine() {
      return many(check(await items().select(ITEM_COLS).eq("author_id", user.id).order("created_at", { ascending: false }).limit(MAX_ROWS)));
    },
    async listQueue() {
      let q = items().select(ITEM_COLS).eq("status", "proposed");
      if (!isAdmin) q = q.eq("author_id", user.id);
      return many(check(await q.order("created_at", { ascending: true }).limit(MAX_ROWS)));
    },
    async listAll(filter?: ReviewFilter) {
      let q = items().select(ITEM_COLS);
      if (filter?.status) q = q.eq("status", filter.status);
      return many(check(await q.order("updated_at", { ascending: false }).limit(Math.min(filter?.limit ?? 100, MAX_ROWS))));
    },
    getItem: one,

    async submit(input: KnowledgeInput) {
      // author_id is the session user; status, reviewer and timestamps are not insertable columns at all.
      const row = check(await items().insert({
        kind: input.kind, scope: input.scope, project_id: input.scope === "project" ? input.project_id : null,
        title: input.title, body: input.body, topic: input.topic, author_id: user.id,
        source_type: input.kind === "correction" ? "correction" : "manual", source_ref: input.source_ref, supersedes_id: input.supersedes_id,
        expires_at: input.expires_on ? `${input.expires_on}T23:59:59.000Z` : null,
      }).select(ITEM_COLS).single()) as unknown as ItemRow;
      return toItem(row);
    },

    async review(id: string, action: ReviewAction, note: string | null) {
      check(await db.rpc("knowledge_review", { p_id: id, p_action: action, p_note: note }));
      const item = await one(id);
      if (!item) throw new UserFacingError("That item was not found.");
      return item;
    },

    async events(itemId: string) {
      if (!isAdmin) return [];
      const rows = check(await db.from("knowledge_events").select(EVENT_COLS).eq("item_id", itemId).order("created_at", { ascending: true })) as unknown as EventRow[] | null;
      return (rows ?? []).map(toEvent);
    },

    async recordFeedback(input: FeedbackInput) {
      // No .select(): members cannot read feedback rows back (administrators-only read policy).
      check(await db.from("answer_feedback").insert({ actor_id: user.id, rating: input.rating, reason: input.reason, intent: input.intent, source_ids: input.source_ids }));
    },
    async feedbackSummary() {
      if (!isAdmin) return { useful: 0, not_useful: 0 };
      return { useful: await count("useful"), not_useful: await count("not_useful") };
    },
  };
}
