import {
  DEFAULT_POLICY, DUPLICATE_OF_VIEWING, InMemoryAuditSink, InMemoryProcessingStore, SYNTHETIC_EMAILS, SYNTHETIC_NOW, dedupeKey, describeAudit,
  normalizeEmail, rulesSelection, sourceRef, toActivityEvents, TaskSinkDenied, parseOwnerRules, processMessage, reviewMessage,
  type AuditEvent, type ClassifierSelection, type PipelineDeps, type ProcessedMessage, type RawEmail, type ReviewDecision, type TaskSink,
} from "@/lib/ai-brain";
import { checkTaskChange } from "@/lib/permissions";
import type { ActivityEvent, Profile, TaskInput } from "@/lib/types";
import { UserFacingError, type AiInboxRepo, type AiInboxView, type AiReviewInput } from "../types";
import { LIMITS } from "./state";
import { DEMO_USERS } from "./users";

/**
 * DEMO ONLY. The AI Inbox in demo mode is built from the repository's SYNTHETIC sample emails, run
 * through the real pipeline on every request (deterministic, no network unless the model classifier is
 * enabled). Only the visitor's decisions persist, in the demo cookie: an approval IS the task
 * (deterministic id; it records who created it and when), a rejection is stored with its reviewer and time.
 * Nothing here reads a mailbox, and the UI labels the data as synthetic.
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
  now(): number;
  /**
   * Decisions this visitor made. Approvals ARE the created tasks (who created them and when is recorded there);
   * rejections are stored with the reviewer and time. Both last as long as the demo cookie (24 h) and are
   * discarded by "Reset demo". They are not a database.
   */
  decisions(): Promise<{
    approved: { index: number; task_id: string; title: string; actor_id: string; at: string }[];
    rejected: { index: number; actor_id: string; at: string }[];
  }>;
  /** Idempotent on `index`: a repeat returns the existing task with created: false. */
  createTask(input: TaskInput, index: number): Promise<{ task_id: string; created: boolean }>;
  /** Records the rejection with the current user and time. */
  reject(index: number): Promise<void>;
}

/** Workflow ids of the sample messages, computed without any classification. */
let refs: string[] | undefined;
const fixtureRefs = (): string[] => (refs ??= DEMO_FIXTURES.map((raw) => sourceRef(dedupeKey(normalizeEmail(raw, { now: SYNTHETIC_NOW }).message))));

const DAY = 86_400_000;
const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function decisionEvent(workflow_id: string, decision: "approved" | "rejected", actorId: string, at: string, task_id: string | null): AuditEvent {
  const e = {
    event_type: "message_classified" as const, status: "processed" as const, stage: "audit" as const, at, workflow_id, task_id,
    classifier: null, intent: null, outcome: decision === "approved" ? ("APPROVED" as const) : ("REJECTED" as const), flags: [],
    error_category: null, actor: { kind: "user" as const, id: actorId }, decision,
  };
  return { ...e, description: describeAudit(e) };
}

export function createDemoAiInbox(host: DemoAiHost, selection: ClassifierSelection = rulesSelection()): AiInboxRepo & { activity(withPipeline?: boolean): Promise<ActivityEvent[]> } {
  const { user } = host;
  const requireAdmin = () => {
    if (user.role !== "admin") throw new UserFacingError("Only administrators can use the AI Inbox.");
  };

  async function build() {
    const store = new InMemoryProcessingStore(() => SYNTHETIC_NOW);
    const audit = new InMemoryAuditSink();
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
      classifier: selection.classifier, store, audit, taskSink: sink,
      ownerRules: DEMO_OWNER_RULES, assignable: new Set(DEMO_USERS.map((u) => u.id)), policy: DEFAULT_POLICY, now: () => SYNTHETIC_NOW,
    };
    // Messages 0..n-2 are independent, so they run concurrently (model calls are slow). The last one is the
    // duplicate delivery and must run AFTER its original so the original keeps the key at its own index.
    const keys: (string | null)[] = new Array(DEMO_FIXTURES.length).fill(null);
    let duplicates = 0;
    const run = async (i: number) => {
      const r = await processMessage(deps, DEMO_FIXTURES[i]);
      if (r.outcome === "duplicate") duplicates++;
      else keys[i] = r.record?.dedupe_key ?? null;
    };
    const last = DEMO_FIXTURES.length - 1;
    await Promise.all(Array.from({ length: last }, (_, i) => run(i)));
    await run(last);
    // Pipeline events are complete at this point; anything emitted later (a review in this request) is not part of the feed.
    const pipelineEvents = [...audit.events];
    // Overlay this visitor's decisions.
    const d = await host.decisions();
    for (const a of d.approved) {
      const key = keys[a.index];
      if (key) await store.update(key, { status: "TASK_CREATED", task_id: a.task_id });
    }
    for (const r of d.rejected) {
      const key = keys[r.index];
      if (key) await store.update(key, { status: "REJECTED", reviewed_by: r.actor_id });
    }
    return { deps, store, pipelineEvents, keys: keys as readonly (string | null)[], duplicates };
  }

  /**
   * Activity-feed events. Pipeline events are regenerated from the synthetic emails (deterministic, stamped relative
   * to "now" so they sort like the sample tasks). Decision events are derived ONLY from what was really recorded:
   * the creator of an approved task, the reviewer and time of a rejection. Events from a review call itself are not
   * kept, because a request-scoped sink cannot be durable and we do not pretend it is.
   * Non-admins never trigger classification; they only see decision events for tasks they can already see.
   */
  async function activity(withPipeline = true): Promise<ActivityEvent[]> {
    const ids = fixtureRefs();
    const d = await host.decisions();
    const decided: AuditEvent[] = [
      ...d.approved.map((a) => decisionEvent(ids[a.index], "approved", a.actor_id, a.at, a.task_id)),
      ...d.rejected.map((r) => decisionEvent(ids[r.index], "rejected", r.actor_id, r.at, null)),
    ];
    const title = new Map(d.approved.map((a) => [a.task_id, a.title]));
    const out = toActivityEvents(decided, { idPrefix: "aid", at: (_i, e) => e.at, taskTitle: (id) => title.get(id) ?? null });
    if (withPipeline && user.role === "admin") {
      const { pipelineEvents } = await build();
      const base = Math.floor(host.now() / DAY) * DAY - DAY + 9 * 3_600_000;
      out.push(...toActivityEvents(pipelineEvents, { idPrefix: "ai", at: (i) => new Date(base + i * 1000).toISOString() }));
    }
    return out;
  }

  return {
    activity,
    async view(): Promise<AiInboxView> {
      requireAdmin();
      const { store, duplicates } = await build();
      const messages: ProcessedMessage[] = await store.list(100);
      return {
        mode: "synthetic", messages, duplicates_suppressed: duplicates,
        classifier: { mode: selection.mode, model: selection.model, note: selection.note },
      };
    },
    async review(dedupeKey, input: AiReviewInput) {
      // Authorize BEFORE building: a non-admin must not be able to trigger (paid) classification.
      if (user.role !== "admin") return { ok: false, error: "forbidden", message: "Only administrators can review AI-proposed tasks." };
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
