import { DEMO_USERS } from "../src/lib/backend/demo/users";
import { checkTaskChange } from "../src/lib/permissions";
import type { TaskInput } from "../src/lib/types";
import {
  DEFAULT_POLICY, InMemoryAuditSink, InMemoryProcessingStore, RuleBasedClassifier, SYNTHETIC_NOW, TaskSinkDenied, parseOwnerRules,
  type Classifier, type Notifier, type PipelineDeps, type ProcessingPolicy, type TaskSink, type TaskSinkContext,
} from "../src/lib/ai-brain";

export const [ADMIN, MEMBER_A, MEMBER_B] = DEMO_USERS;
export const ASSIGNABLE: ReadonlySet<string> = new Set(DEMO_USERS.map((u) => u.id));

// Synthetic ownership configuration (demo user ids). Real rules come from Broko's configuration.
export const OWNER_RULES = parseOwnerRules([
  { id: "viewings", priority: 100, when: { intents: ["viewing_request"] }, owner_id: MEMBER_A.id },
  { id: "finance", priority: 90, when: { intents: ["payment_or_invoice", "legal_or_compliance"] }, owner_id: ADMIN.id },
  { id: "fallback", priority: 1, when: {}, owner_id: MEMBER_B.id },
]);

/** Task backend stand-in: idempotent on dedupe_key, and it enforces the SAME permission rule as the dashboard. */
export class FakeTaskSink implements TaskSink {
  readonly tasks = new Map<string, { task_id: string; input: TaskInput; ctx: TaskSinkContext }>();
  calls = 0;
  allowSystem = false;
  async createTask(input: TaskInput, ctx: TaskSinkContext) {
    this.calls++;
    await Promise.resolve();
    if (ctx.actor.kind === "system" && !this.allowSystem) throw new TaskSinkDenied("automatic task creation is not permitted");
    if (ctx.actor.kind === "user") {
      const denied = checkTaskChange(ctx.actor.profile, null, { assigned_to: input.assigned_to });
      if (denied) throw new TaskSinkDenied(denied);
    }
    const existing = this.tasks.get(ctx.dedupe_key);
    if (existing) return { task_id: existing.task_id, created: false };
    const task_id = `task-${this.tasks.size + 1}`;
    this.tasks.set(ctx.dedupe_key, { task_id, input, ctx });
    return { task_id, created: true };
  }
}

export class FakeNotifier implements Notifier {
  calls: { owner_id: string; task_id: string }[] = [];
  constructor(private readonly result: { sent: boolean; detail: string } = { sent: true, detail: "delivered (fake)" }) {}
  async notify(n: { owner_id: string; task_id: string }) {
    this.calls.push({ owner_id: n.owner_id, task_id: n.task_id });
    return this.result;
  }
}

export class CountingClassifier implements Classifier {
  readonly name = "counting";
  calls = 0;
  constructor(private readonly inner: Classifier = new RuleBasedClassifier(), private readonly delayMs = 0) {}
  async analyze(msg: Parameters<Classifier["analyze"]>[0]) {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.analyze(msg);
  }
}

export function makeDeps(over: Partial<Omit<PipelineDeps, "policy">> & { policy?: Partial<ProcessingPolicy> } = {}) {
  const store = new InMemoryProcessingStore();
  const audit = new InMemoryAuditSink();
  const sink = new FakeTaskSink();
  const classifier = new CountingClassifier();
  const { policy, ...rest } = over;
  const deps: PipelineDeps = {
    classifier, store, audit, taskSink: sink, ownerRules: OWNER_RULES, assignable: ASSIGNABLE,
    policy: { ...DEFAULT_POLICY, ...policy }, now: () => SYNTHETIC_NOW, ...rest,
  };
  return { deps, store, audit, sink, classifier };
}
