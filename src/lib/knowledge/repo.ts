import type { FeedbackInput, KnowledgeEvent, KnowledgeInput, KnowledgeItem, ReviewAction, ReviewFilter } from "./types";

/**
 * Data access for governed organizational knowledge, scoped to the signed-in user. Mirrors the shape of `PreconRepo`: the Supabase
 * implementation relies on row level security and the review function in supabase/proposed/0009, and every implementation must
 * independently refuse what the user may not do (members never approve; a proposal is never visible to other members; project
 * knowledge is visible only with the project). Absent on `Repo` = not connected.
 */
export interface KnowledgeRepo {
  /** False for the demo: it shows labelled synthetic items and refuses every write with a clear message. */
  readonly writable: boolean;

  /** Approved items that are in effect and not expired, which this user may see. The only list the Brain reads. */
  listCurrent(): Promise<KnowledgeItem[]>;
  /** Everything this user submitted, in any status, newest first. */
  listMine(): Promise<KnowledgeItem[]>;
  /** Items awaiting review that this user may see (administrators: all of them, oldest first; anyone else: only their own). */
  listQueue(): Promise<KnowledgeItem[]>;
  /** Recent items in any status that this user may see (administrators: all). */
  listAll(filter?: ReviewFilter): Promise<KnowledgeItem[]>;
  getItem(id: string): Promise<KnowledgeItem | null>;

  /** Always creates a PROPOSED item authored by the caller. Status, author and timestamps are never taken from the input. */
  submit(input: KnowledgeInput): Promise<KnowledgeItem>;
  /** Administrators only. Approve / reject a proposed item, or expire an approved one. Approving a replacement supersedes its target. */
  review(id: string, action: ReviewAction, note: string | null): Promise<KnowledgeItem>;
  /** Change history of one item. Administrators only (everyone else gets an empty list). */
  events(itemId: string): Promise<KnowledgeEvent[]>;

  /** Metadata-only answer feedback. Never contains the question or the answer. */
  recordFeedback(input: FeedbackInput): Promise<void>;
  /** Administrators: how many people found answers useful or not, in total. */
  feedbackSummary(): Promise<{ useful: number; not_useful: number }>;
}
