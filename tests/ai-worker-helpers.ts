import {
  AiWorker, DEFAULT_POLICY, InMemoryAuditSink, InMemoryJobStore, InMemoryProcessingStore, SYNTHETIC_EMAILS, SYNTHETIC_NOW, SyntheticMessageFetcher,
  loadAiBrainConfig, rulesSelection, selectClassifier, type ClassifierSelection, type LlmTransport, type MessageRef, type RawEmail, type WorkerConfig,
} from "../src/lib/ai-brain";
import type { DemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import { ASSIGNABLE, FakeTaskSink, OWNER_RULES } from "./ai-brain-helpers";

/** A controllable clock so leases and backoff are deterministic. */
export function makeClock(start: Date = SYNTHETIC_NOW) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, set: (d: Date) => { t = d.getTime(); } };
}

export const refOf = (m: RawEmail): MessageRef => ({ provider: m.provider, mailbox_ref: m.mailboxRef, source_message_id: m.id });
/** Every synthetic email except the one that cannot be normalised. */
export const MESSAGES: RawEmail[] = Object.entries(SYNTHETIC_EMAILS).filter(([k]) => k !== "invalidSender").map(([, v]) => v);

export const modelSelection = (transport: LlmTransport, key = "TEST-KEY-NOT-REAL"): ClassifierSelection =>
  selectClassifier(loadAiBrainConfig({ BROKO_AI_CLASSIFIER: "llm", ANTHROPIC_API_KEY: key }), { transport });

export interface HarnessOptions {
  selection?: ClassifierSelection;
  messages?: RawEmail[];
  config?: Partial<WorkerConfig>;
  maxAttempts?: number;
}

/** One shared job store, record store, audit sink and fetcher; any number of workers. */
export function harness(opts: HarnessOptions = {}) {
  const clock = makeClock();
  const jobs = new InMemoryJobStore();
  const records = new InMemoryProcessingStore(clock.now);
  const audit = new InMemoryAuditSink();
  const sink = new FakeTaskSink();
  const messages = opts.messages ?? MESSAGES;
  const fetcher = new SyntheticMessageFetcher(messages);
  const selection = opts.selection ?? rulesSelection();
  const worker = (id = "worker-1") => new AiWorker({
    jobs, fetcher, selection, workerId: id, now: clock.now, jitter: () => 1,
    config: { leaseMs: 60_000, classifyTimeoutMs: 1_000, backoffBaseMs: 5_000, backoffCapMs: 300_000, ...opts.config },
    pipeline: { store: records, audit, taskSink: sink, ownerRules: OWNER_RULES, assignable: ASSIGNABLE, policy: DEFAULT_POLICY, now: clock.now },
  });
  const enqueueAll = async (list: RawEmail[] = messages) => {
    for (const m of list) await jobs.enqueue(refOf(m), clock.now(), { max_attempts: opts.maxAttempts });
  };
  return { clock, jobs, records, audit, sink, fetcher, selection, worker, enqueueAll, messages };
}

/** Runs a demo runtime's worker repeatedly, advancing the clock past every backoff, until nothing is left to retry. */
export async function settle(rt: DemoAiRuntime, clock: ReturnType<typeof makeClock>, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await rt.drain();
    clock.advance(60_000);
  }
}
