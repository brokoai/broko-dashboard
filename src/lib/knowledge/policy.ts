import type { Profile } from "@/lib/types";
import { STALE_AFTER_DAYS, type KnowledgeItem, type ReviewAction } from "./types";

// Business rules for organizational knowledge, independent of any backend. The service applies them before every write, the
// Brain adapter applies them again before every read, and the database (supabase/proposed/0009) enforces the same rules
// independently with row level security and a SECURITY DEFINER review function.

const DAY_MS = 86_400_000;

/** Administrators review. Members (and everyone else) can only submit proposals. There is no "approve my own" path for members. */
export const canReview = (u: Profile): boolean => u.role === "admin";
/** Any signed-in user may PROPOSE knowledge; a proposal never influences an answer until an administrator approves it. */
export const canSubmit = (u: Profile): boolean => !!u.id;

/** Approved, already in effect, and not past its expiry. Everything the Brain may use must pass this. */
export function isCurrent(item: Pick<KnowledgeItem, "status" | "effective_from" | "expires_at">, now: Date): boolean {
  if (item.status !== "approved") return false;
  if (new Date(item.effective_from).getTime() > now.getTime()) return false;
  return !item.expires_at || new Date(item.expires_at).getTime() > now.getTime();
}

/** Current, but nobody has reviewed it for a long time: still usable, always labelled. */
export function isStale(item: Pick<KnowledgeItem, "reviewed_at" | "created_at">, now: Date): boolean {
  const base = new Date(item.reviewed_at ?? item.created_at).getTime();
  return Number.isFinite(base) && now.getTime() - base > STALE_AFTER_DAYS * DAY_MS;
}

export const ageInDays = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));

/**
 * Whether this user may see an item. Mirrors the select policy in 0009: administrators see everything; an author sees their own
 * submissions in any status; everyone else sees only current approved items, and project items only for projects they can see
 * (`visibleProjectIds` = null means the project list could not be established, so project items are withheld: fail closed).
 */
export function canSeeItem(user: Profile, item: KnowledgeItem, visibleProjectIds: ReadonlySet<string> | null, now: Date): boolean {
  if (user.role === "admin") return true;
  if (item.author_id === user.id) return true;
  if (!isCurrent(item, now)) return false;
  if (item.scope === "organization") return true;
  return !!item.project_id && !!visibleProjectIds && visibleProjectIds.has(item.project_id);
}

/** Returns a user-facing reason if this review action is not allowed on this item, otherwise null. */
export function checkReview(item: Pick<KnowledgeItem, "status" | "expires_at">, action: ReviewAction, note: string | null, now: Date): string | null {
  if (action === "approve" || action === "reject") {
    if (item.status !== "proposed") return "Only proposed items can be reviewed.";
    if (action === "reject" && !note) return "Give a short reason when rejecting, so the author knows why.";
    if (action === "approve" && item.expires_at && new Date(item.expires_at).getTime() <= now.getTime()) return "This item has already expired and cannot be approved.";
    return null;
  }
  return item.status === "approved" ? null : "Only approved items can be expired.";
}

export const REPLACEMENT_MISMATCH = "A replacement must apply to the same scope, project and topic as the item it replaces.";

/** A replacement may only retire an item of the same scope, project and topic (project empty for the whole organization; topic compared null-safely). */
type ReplacementKey = Pick<KnowledgeItem, "scope" | "project_id"> & { topic?: string | null };
export function sameReplacementScope(a: ReplacementKey, b: ReplacementKey): boolean {
  return a.scope === b.scope && (a.project_id ?? null) === (b.project_id ?? null) && (a.topic ?? null) === (b.topic ?? null);
}

/** What the review card says about the older item a proposal names. Pure, so every wording is tested without rendering. */
export type ReplacementView =
  | { kind: "none" }
  /** Proposed, and approving it WILL retire `title`. */
  | { kind: "will_replace"; title: string }
  /** Proposed, but the named item has a different scope, project or topic: the database refuses to approve it. */
  | { kind: "mismatch"; title: string }
  /** Proposed, but the named item is no longer approved, so approving changes nothing else. */
  | { kind: "inactive"; title: string; status: KnowledgeItem["status"] }
  /** The named item could not be loaded. */
  | { kind: "unavailable" }
  /** Not proposed any more: shown as plain history. */
  | { kind: "history"; title: string };

export function describeReplacement(item: Pick<KnowledgeItem, "status" | "supersedes_id" | "scope" | "project_id" | "topic">, target: Pick<KnowledgeItem, "title" | "status" | "scope" | "project_id" | "topic"> | null | undefined): ReplacementView {
  if (!item.supersedes_id) return { kind: "none" };
  if (!target) return { kind: "unavailable" };
  if (item.status !== "proposed") return { kind: "history", title: target.title };
  if (target.status !== "approved") return { kind: "inactive", title: target.title, status: target.status };
  return sameReplacementScope(item, target) ? { kind: "will_replace", title: target.title } : { kind: "mismatch", title: target.title };
}

/** Two or more CURRENT items sharing a topic. Reported to the user; never silently resolved. */
export function conflictGroups(items: readonly KnowledgeItem[], now: Date): KnowledgeItem[][] {
  const byTopic = new Map<string, KnowledgeItem[]>();
  for (const it of items) {
    if (!it.topic || !isCurrent(it, now)) continue;
    byTopic.set(it.topic, [...(byTopic.get(it.topic) ?? []), it]);
  }
  return [...byTopic.values()].filter((g) => g.length > 1 && new Set(g.map((i) => i.body)).size > 1);
}
