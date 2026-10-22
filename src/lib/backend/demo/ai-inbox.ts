import {
  DEFAULT_POLICY, DUPLICATE_OF_VIEWING, InMemoryAuditSink, InMemoryProcessingStore, RuleBasedClassifier, SYNTHETIC_EMAILS, SYNTHETIC_NOW,
  TaskSinkDenied, parseOwnerRules, processMessage, reviewMessage,
  type PipelineDeps, type ProcessedMessage, type RawEmail, type ReviewDecision, type TaskSink,
} from "@/lib/ai-brain";
import { checkTaskChange } from "@/lib/permissions";
import type { Profile, TaskInput } from "@/lib/types";
import { UserFacingError, type AiInboxRepo, type AiInboxView, type AiReviewInput } from "../types";
import { LIMITS } from "./state";
import { DEMO_USERS } from "./users";

/**
 * DEMO ONLY. The AI Inbox in demo mode is built from the repository's SYNTHETIC sample emails, run
 * through the real pipeline on every request (deterministic, no network, no model call). Only the
 * visitor's decisions persist: an approval IS the task (deterministic id), a rejection is stored by
 * index. Nothing here reads a mailbox, and the UI labels the data as synthetic.
 */

const [ADMIN, MEMBER_A, MEMBER_B] = DEMO_USERS;

/** Synthetic ownership configuration (demo user ids). Real rules come from Broko's configuration. */
export const DEMO_OWNER_RULES = parseOwnerRules([
  { id: "viewings", priority: 100, when: { intents: ["viewing_request"] }, owner_id: MEMBER_A.id },
  { id: "finance", priority: 90, when: { intents: ["payment_or_invoice", "legal_or_compliance"] }, owner_id: ADMIN.id },
  { id: "fallback", priority: 1, when: {}, owner_id: MEMBER_B.id },
]);

/** Order matters: the index identifies the message in the visitor's stored decisions. */
export const DEMO_FIXTURES: readonly RawEmail[] = [
  SYNTHETIC_EMAILS.viewingComplete, SYNTHETIC_EMAILS.viewingVague, SYNTHETIC_EMAILS.invoice, SYNTHETIC_EMAILS.legal,
  SYNTHETIC_EMAILS.injection, SYNTHETIC_EMAILS.spam, SYNTHETIC_EMAILS.hiddenHtml, SYNTHETIC_EMAILS.urgentComplaint,
  SYNTHETIC_EMAILS.quotedThread, DUPLICATE_OF_VIEWING,
];

/** What the visitor's storage can tell us, and how it records a decision. Implemented by the demo repo. */
export interface DemoAiHost {
  user: Profile;
  /** fixture index -> id of the task created from it. */
  approved(): Promise<Map<number, string>>;
  rejected(): Promise<number[]>;
  /** Idempotent on `index`: a repeat returns the existing task with created: false. */
  createTask(input: TaskInput, index: number): Promise<{ task_id: string; created: boolean }>;
  reject(index: number): Promise<void>;
}

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createDemoAiInbox(host: DemoAiHost): AiInboxRepo {
  const { user } = host;
  const requireAdmin = () => {
    if (user.role !== "admin") throw new UserFacingError("Only administrators can use the AI Inbox.");
  };

  async function build() {
    const store = new InMemoryProcessingStore(() => SYNTHETIC_NOW);
    const sink: TaskSink = {
      async createTask(input, ctx) {
        if (ctx.actor.kind !== "user") throw new TaskSinkDenied("Automatic task creation is not available in the demo.");
        const denied = checkTaskChange(ctx.actor.profile, null, { assigned_to: input.assigned_to });
        if (denied) throw new TaskSinkDenied(denied);
        const index = keys.indexOf(ctx.dedupe_key);
        if (index < 0) throw new TaskSinkDenied("Unknown message.");
        try {
          // The demo's per-visitor storage is tiny, so it keeps shortened task text.
          return await host.createTask({ ...input, title: clipTo(input.title, LIMITS.title), description: input.description === null ? null : clipTo(input.description, LIMITS.description) }, index);
        } catch (e) {
          if (e instanceof UserFacingError) throw new TaskSinkDenied(e.message);
          throw e;
        }
      },
    };
    const deps: PipelineDeps = {
      classifier: new RuleBasedClassifier(), store, audit: new InMemoryAuditSink(), taskSink: sink,
      ownerRules: DEMO_OWNER_RULES, assignable: new Set(DEMO_USERS.map((u) => u.id)), policy: DEFAULT_POLICY, now: () => SYNTHETIC_NOW,
    };
    const keys: (string | null)[] = [];
    let duplicates = 0;
    for (const raw of DEMO_FIXTURES) {
      const r = await processMessage(deps, raw);
      if (r.outcome === "duplicate") duplicates++;
      keys.push(r.outcome === "duplicate" ? null : r.record?.dedupe_key ?? null);
    }
    // Overlay this visitor's decisions.
    for (const [index, taskId] of await host.approved()) {
      const key = keys[index];
      if (key) await store.update(key, { status: "TASK_CREATED", task_id: taskId });
    }
    for (const index of await host.rejected()) {
      const key = keys[index];
      if (key) await store.update(key, { status: "REJECTED" });
    }
    return { deps, store, keys: keys as readonly (string | null)[], duplicates };
  }

  return {
    async view(): Promise<AiInboxView> {
      requireAdmin();
      const { store, duplicates } = await build();
      const messages: ProcessedMessage[] = await store.list(100);
      return { mode: "synthetic", messages, duplicates_suppressed: duplicates };
    },
    async review(dedupeKey, input: AiReviewInput) {
      const { deps, keys } = await build();
      const decision: ReviewDecision = input.action === "reject"
        ? { action: "reject", by: user }
        : { action: "approve", by: user, assigned_to: input.assigned_to, due_at: input.due_at, priority: input.priority };
      const result = await reviewMessage(deps, dedupeKey, decision);
      const index = keys.indexOf(dedupeKey);
      if (result.ok && input.action === "reject" && index >= 0) await host.reject(index);
      return result;
    },
  };
}
