import type { AuditEvent, AuditSink, EmailProvider, Notifier, ProcessingStore, ProviderConnection } from "./ports";
import type { ProcessedMessage, ProcessingStatus, RawEmail, SourceProvider } from "./schema";

/**
 * In-memory implementations for TESTS and the demo. They are not persistent and must never be
 * used as the production store: a restart loses every record and idempotency guarantee.
 */
export class InMemoryProcessingStore implements ProcessingStore {
  private readonly rows = new Map<string, ProcessedMessage>();

  // Synchronous check-and-set inside one tick, so concurrent claims cannot both succeed.
  async claim(record: ProcessedMessage) {
    const existing = this.rows.get(record.dedupe_key);
    if (existing) return { claimed: false, record: structuredClone(existing) };
    this.rows.set(record.dedupe_key, structuredClone(record));
    return { claimed: true, record: structuredClone(record) };
  }
  async get(key: string) {
    const r = this.rows.get(key);
    return r ? structuredClone(r) : null;
  }
  async update(key: string, patch: Partial<ProcessedMessage>) {
    const cur = this.rows.get(key);
    if (!cur) throw new Error("record not found");
    const next = { ...cur, ...structuredClone(patch), updated_at: new Date().toISOString() } as ProcessedMessage;
    this.rows.set(key, next);
    return structuredClone(next);
  }
  async transition(key: string, from: readonly ProcessingStatus[], patch: Partial<ProcessedMessage>) {
    const cur = this.rows.get(key);
    if (!cur || !from.includes(cur.status)) return null;
    return this.update(key, patch);
  }
  async list(limit: number) {
    return [...this.rows.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map((r) => structuredClone(r));
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(e: AuditEvent) { this.events.push(structuredClone(e)); }
}

/** Honest default: says plainly that nothing was sent. */
export class UnconfiguredNotifier implements Notifier {
  async notify() { return { sent: false, detail: "notification adapter not configured" }; }
}

// ---------------------------------------------------------------------------- providers
/** Placeholder for a real provider that has not been set up. Never reports "connected". */
export class UnconfiguredEmailProvider implements EmailProvider {
  constructor(readonly provider: SourceProvider) {}
  async connection(): Promise<ProviderConnection> {
    return { status: "pending_setup", last_sync_at: null, last_error: null, synthetic: false };
  }
  async fetchNew(): Promise<{ messages: RawEmail[]; nextCursor: string | null }> {
    throw new Error(`${this.provider} is not configured: no messages can be fetched`);
  }
}

/** Fixture-backed provider for tests/demo. Flagged `synthetic`, so it can never pass for a real mailbox. */
export class SyntheticEmailProvider implements EmailProvider {
  readonly provider = "synthetic" as const;
  constructor(private readonly messages: RawEmail[]) {}
  async connection(): Promise<ProviderConnection> {
    return { status: "pending_setup", last_sync_at: null, last_error: null, synthetic: true };
  }
  async fetchNew(cursor: string | null, limit: number) {
    const start = cursor ? Number(cursor) : 0;
    const slice = this.messages.slice(start, start + limit);
    const next = start + slice.length;
    return { messages: slice, nextCursor: next < this.messages.length ? String(next) : null };
  }
}
