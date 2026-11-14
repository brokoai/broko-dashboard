import { randomUUID } from "node:crypto";
import { UserFacingError } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";
import { REPLACEMENT_MISMATCH, canReview, canSeeItem, checkReview, isCurrent, sameReplacementScope } from "./policy";
import type { KnowledgeRepo } from "./repo";
import type { FeedbackInput, KnowledgeEvent, KnowledgeItem } from "./types";

/**
 * In-memory implementation of KnowledgeRepo. It backs the read-only demo (synthetic items) and the tests. It enforces the same
 * rules as the database policies in supabase/proposed/0009, independently of the pages and actions. Nothing here touches a
 * network or the filesystem.
 */

export interface StoredFeedback { actor_id: string; rating: string; reason: string | null; intent: string | null; source_ids: string[]; at: string }
export interface KnowledgeStore { items: KnowledgeItem[]; events: KnowledgeEvent[]; feedback: StoredFeedback[] }
export const emptyKnowledgeStore = (): KnowledgeStore => ({ items: [], events: [], feedback: [] });

const DENIED = "You do not have permission to do that.";
const READ_ONLY = "The demo is read-only: knowledge cannot be submitted or reviewed here.";
/** Same ceilings as the database triggers in 0009 (per user, per rolling minute). */
export const SUBMIT_CAP_PER_MINUTE = 30;
export const FEEDBACK_CAP_PER_MINUTE = 60;

export function createMemoryKnowledgeRepo(opts: {
  user: Profile;
  store: KnowledgeStore;
  writable: boolean;
  /** Ids of the projects this user may see. Project knowledge is visible only for these. Null = unknown, so none (fail closed). */
  projectIds: () => Promise<ReadonlySet<string> | null>;
  now?: () => Date;
}): KnowledgeRepo {
  const { user, store } = opts;
  const clock = () => (opts.now ?? (() => new Date()))();
  const iso = () => clock().toISOString();
  const writeGuard = () => { if (!opts.writable) throw new UserFacingError(READ_ONLY); };
  const find = (id: string) => store.items.find((i) => i.id === id);
  const copy = (i: KnowledgeItem): KnowledgeItem => ({ ...i });
  const visible = async (): Promise<KnowledgeItem[]> => {
    const projects = await opts.projectIds();
    const now = clock();
    return store.items.filter((i) => canSeeItem(user, i, projects, now));
  };
  const log = (item: KnowledgeItem, action: KnowledgeEvent["action"], from: KnowledgeItem["status"] | null, note: string | null) => {
    store.events.push({ id: randomUUID(), item_id: item.id, actor_id: user.id, actor_name: user.full_name, action, from_status: from, to_status: item.status, note, created_at: iso() });
  };
  const withinMinute = (iso0: string) => clock().getTime() - new Date(iso0).getTime() < 60_000;

  return {
    writable: opts.writable,

    async listCurrent() {
      const now = clock();
      return (await visible()).filter((i) => isCurrent(i, now)).map(copy);
    },
    async listMine() {
      return store.items.filter((i) => i.author_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(copy);
    },
    async listQueue() {
      return (await visible()).filter((i) => i.status === "proposed").sort((a, b) => a.created_at.localeCompare(b.created_at)).map(copy);
    },
    async listAll(filter) {
      return (await visible())
        .filter((i) => !filter?.status || i.status === filter.status)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, Math.min(filter?.limit ?? 100, 200)).map(copy);
    },
    async getItem(id) {
      const i = (await visible()).find((x) => x.id === id);
      return i ? copy(i) : null;
    },

    async submit(input) {
      writeGuard();
      if (store.items.filter((i) => i.author_id === user.id && withinMinute(i.created_at)).length >= SUBMIT_CAP_PER_MINUTE) {
        throw new UserFacingError("You are submitting too quickly. Please wait a minute and try again.");
      }
      if (input.scope === "project") {
        const projects = await opts.projectIds();
        if (!input.project_id || !projects?.has(input.project_id)) throw new UserFacingError("That project was not found.");
      }
      if (input.supersedes_id) {
        const target = (await visible()).find((i) => i.id === input.supersedes_id);
        if (!target) throw new UserFacingError("The item you want to replace was not found.");
        if (!sameReplacementScope(target, { scope: input.scope, project_id: input.scope === "project" ? input.project_id : null, topic: input.topic })) throw new UserFacingError(REPLACEMENT_MISMATCH);
      }
      const now = iso();
      const item: KnowledgeItem = {
        id: randomUUID(), kind: input.kind, scope: input.scope, project_id: input.scope === "project" ? input.project_id : null,
        title: input.title, body: input.body, topic: input.topic, status: "proposed",
        author_id: user.id, author_name: user.full_name, source_type: input.kind === "correction" ? "correction" : "manual", source_ref: input.source_ref,
        supersedes_id: input.supersedes_id, effective_from: now, expires_at: input.expires_on ? `${input.expires_on}T23:59:59.000Z` : null,
        created_at: now, updated_at: now, reviewed_by: null, reviewer_name: null, reviewed_at: null, review_note: null,
      };
      store.items.push(item);
      log(item, "submitted", null, null);
      return copy(item);
    },

    async review(id, action, note) {
      writeGuard();
      if (!canReview(user)) throw new UserFacingError(DENIED);
      const item = find(id);
      if (!item) throw new UserFacingError("That item was not found.");
      const problem = checkReview(item, action, note, clock());
      if (problem) throw new UserFacingError(problem);
      const now = iso();
      const from = item.status;
      if (action === "approve") {
        const prior = item.supersedes_id ? find(item.supersedes_id) : undefined;
        if (prior && prior.status === "approved") {
          if (!sameReplacementScope(prior, item)) throw new UserFacingError(REPLACEMENT_MISMATCH);
          prior.status = "superseded"; prior.updated_at = now;
          log(prior, "superseded", "approved", `Replaced by "${item.title}"`);
        }
        item.status = "approved";
      } else item.status = action === "reject" ? "rejected" : "expired";
      // Like the database: expiring keeps the original approver and note on the item; who expired it is in the history.
      if (action !== "expire") Object.assign(item, { reviewed_by: user.id, reviewer_name: user.full_name, reviewed_at: now, review_note: note });
      item.updated_at = now;
      log(item, action === "approve" ? "approved" : action === "reject" ? "rejected" : "expired", from, note);
      return copy(item);
    },

    async events(itemId) {
      if (!canReview(user)) return [];
      return store.events.filter((e) => e.item_id === itemId).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((e) => ({ ...e }));
    },

    async recordFeedback(input: FeedbackInput) {
      writeGuard();
      if (store.feedback.filter((f) => f.actor_id === user.id && withinMinute(f.at)).length >= FEEDBACK_CAP_PER_MINUTE) {
        throw new UserFacingError("You are sending feedback too quickly. Please wait a minute and try again.");
      }
      store.feedback.push({ actor_id: user.id, rating: input.rating, reason: input.reason, intent: input.intent, source_ids: [...input.source_ids], at: iso() });
    },
    async feedbackSummary() {
      if (!canReview(user)) return { useful: 0, not_useful: 0 };
      return { useful: store.feedback.filter((f) => f.rating === "useful").length, not_useful: store.feedback.filter((f) => f.rating === "not_useful").length };
    },
  };
}
