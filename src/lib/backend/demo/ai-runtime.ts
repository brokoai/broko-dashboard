import {
  AiWorker, DEFAULT_POLICY, InMemoryAuditSink, InMemoryJobStore, InMemoryProcessingStore, SYNTHETIC_EMAILS, SYNTHETIC_NOW, SyntheticMessageFetcher,
  DUPLICATE_OF_VIEWING, dedupeKey, normalizeEmail, parseOwnerRules,
  type ClassifierSelection, type DrainSummary, type MessageRef, type RawEmail, type WorkerConfig,
} from "@/lib/ai-brain";
import { DEMO_USERS } from "./users";

/**
 * DEMO / LOCAL HARNESS ONLY. Owns the shared, in-memory job store, record store, audit sink and worker for the synthetic
 * AI Inbox. It is NOT durable and NOT shared between serverless instances, so it must never be described as a production queue.
 * The page only READS this state; classification happens in `drain()`, which is triggered after the response or by an
 * explicit administrator action. The worker is built without a task sink, so it structurally cannot create tasks.
 *
 * Synthetic data is identical for every visitor, so one shared runtime is harmless. Each visitor's own decisions
 * (approvals, rejections) stay in their demo cookie and are overlaid per request without touching this shared state.
 */

const [ADMIN, MEMBER_A, MEMBER_B] = DEMO_USERS;

/** Synthetic ownership configuration (demo user ids). Real rules come from Broko's configuration. */
export const DEMO_OWNER_RULES = parseOwnerRules([
  { id: "viewings", priority: 100, when: { intents: ["viewing_request"] }, owner_id: MEMBER_A.id },
  { id: "finance", priority: 90, when: { intents: ["payment_or_invoice", "legal_or_compliance"] }, owner_id: ADMIN.id },
  { id: "fallback", priority: 1, when: {}, owner_id: MEMBER_B.id },
]);

/** Order matters: the index identifies the message in the visitor's stored decisions. The duplicate delivery is last. */
export const DEMO_FIXTURES: readonly RawEmail[] = [
  SYNTHETIC_EMAILS.viewingComplete, SYNTHETIC_EMAILS.viewingVague, SYNTHETIC_EMAILS.invoice, SYNTHETIC_EMAILS.legal,
  SYNTHETIC_EMAILS.injection, SYNTHETIC_EMAILS.spam, SYNTHETIC_EMAILS.hiddenHtml, SYNTHETIC_EMAILS.urgentComplaint,
  SYNTHETIC_EMAILS.quotedThread, DUPLICATE_OF_VIEWING,
];

const refOf = (m: RawEmail): MessageRef => ({ provider: m.provider, mailbox_ref: m.mailboxRef, source_message_id: m.id });

/** Dedupe keys of the sample messages by fixture index (computed without any classification). The duplicate shares index 0's key. */
let keys: string[] | undefined;
export const fixtureKeys = (): string[] => (keys ??= DEMO_FIXTURES.map((raw) => dedupeKey(normalizeEmail(raw, { now: SYNTHETIC_NOW }).message)));

export interface DemoAiRuntime {
  selection: ClassifierSelection;
  jobs: InMemoryJobStore;
  records: InMemoryProcessingStore;
  audit: InMemoryAuditSink;
  now: () => Date;
  /** Idempotent: queues every sample message that is not queued yet. Cheap (no content is read, nothing is classified). */
  ensureQueued(): Promise<void>;
  /** Runs the worker until no job is due. This is where classification (and any model call) happens. */
  drain(opts?: { max?: number; concurrency?: number }): Promise<DrainSummary>;
}

export function createDemoAiRuntime(selection: ClassifierSelection, opts: { now?: () => Date; config?: Partial<WorkerConfig>; jitter?: () => number; maxAttempts?: number } = {}): DemoAiRuntime {
  const now = opts.now ?? (() => new Date());
  const jobs = new InMemoryJobStore();
  const records = new InMemoryProcessingStore(() => SYNTHETIC_NOW);
  const audit = new InMemoryAuditSink();
  const worker = new AiWorker({
    jobs, selection, workerId: "demo-worker", now, jitter: opts.jitter,
    fetcher: new SyntheticMessageFetcher(DEMO_FIXTURES),
    // Deliberately no taskSink: a worker can classify and propose, never create tasks.
    pipeline: { store: records, audit, ownerRules: DEMO_OWNER_RULES, assignable: new Set(DEMO_USERS.map((u) => u.id)), policy: DEFAULT_POLICY, now: () => SYNTHETIC_NOW },
    config: { backoffBaseMs: 3_000, backoffCapMs: 30_000, ...opts.config },
  });
  return {
    selection, jobs, records, audit, now,
    async ensureQueued() {
      for (const m of DEMO_FIXTURES) await jobs.enqueue(refOf(m), now(), { max_attempts: opts.maxAttempts });
    },
    drain: (o) => worker.drain(o),
  };
}

/** One runtime per classifier selection (the app has one; tests make their own). */
const runtimes = new WeakMap<ClassifierSelection, DemoAiRuntime>();
export const runtimeFor = (selection: ClassifierSelection): DemoAiRuntime => {
  let rt = runtimes.get(selection);
  if (!rt) runtimes.set(selection, (rt = createDemoAiRuntime(selection)));
  return rt;
};
