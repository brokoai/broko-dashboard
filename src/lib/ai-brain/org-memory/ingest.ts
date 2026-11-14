import { sanitizeDocument } from "../assistant/meetings/analysis";
import type { ConnectorFailure, NotionConnector } from "../assistant/connectors";
import type { MeetingCandidate } from "../assistant/meetings/types";
import type { Extractor } from "./extract";
import type { RelationshipExtractor } from "./extract-relationships";
import { validateRelationships } from "./relationships";
import { validateExtraction } from "./validate";
import type { FailureCode, IngestRunReport, OrgMemoryWriter } from "./types";

/**
 * Ingestion of authorized Notion content into persistent memory, through the EXISTING Notion connector (no second connector, no token here).
 *
 *   discovery -> (skip if the source says it is unchanged) -> fetch -> normalize + sanitize -> L0 persist (hash compare) -> extract -> validate -> L1 persist
 *
 * It is a server-side job: nothing in chat can start it. Every step is idempotent (running it twice in a row changes nothing the second time), a failed
 * source is recorded with a fixed failure code and retried up to a limit, and a failure of one document never stops the rest.
 */

export const DISCOVERY_LIMIT = 100; // the connector pages through Notion itself and returns at most this many per run
export const DEFAULT_MAX_DOCS = 25;
export const DEFAULT_MAX_EXTRACT = 10;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface IngestDeps { notion: NotionConnector; writer: OrgMemoryWriter; extractor: Extractor | null; relationshipExtractor?: RelationshipExtractor | null }
export interface IngestOptions {
  workspaceId: string;
  /** Documents fetched per run. The rest wait for the next run (most recently edited first). */
  maxDocs?: number;
  maxExtract?: number;
  maxAttempts?: number;
  now?: () => Date;
}

const code = (r: ConnectorFailure): FailureCode => (r === "not_implemented" ? "error" : r);
const empty = (): IngestRunReport => ({
  discovered: 0, created: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, archived: 0, retried: 0, extracted_docs: 0, extraction_failed: 0,
  entities_created: 0, entities_updated: 0, entities_staled: 0, entities_rejected: 0, owners_dropped: 0, dates_dropped: 0, discovery_failure: null,
  relationships_created: 0, relationships_updated: 0, relationships_staled: 0, relationships_rejected: 0, relationships_downgraded: 0, relationship_extraction_failed: 0,
  reconcile_skipped_truncated: 0,
});

export async function runIngestion(deps: IngestDeps, opts: IngestOptions): Promise<IngestRunReport> {
  const { notion, writer, extractor } = deps;
  const clock = opts.now ?? (() => new Date());
  const ws = opts.workspaceId;
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const report = empty();

  // 1. Discovery.
  let candidates: MeetingCandidate[] = [];
  let listingComplete = false;
  try {
    const found = await notion.findMeetingCandidates([], DISCOVERY_LIMIT);
    if (found.ok) { candidates = found.data; listingComplete = found.data.length < DISCOVERY_LIMIT; } else report.discovery_failure = code(found.reason);
  } catch { report.discovery_failure = "error"; }
  report.discovered = candidates.length;
  candidates.sort((a, b) => (b.last_edited ?? "").localeCompare(a.last_edited ?? ""));

  // Sources whose last read failed are retried (up to a limit), even if discovery did not list them this time.
  const retryable = await writer.listRetryable("notion", ws, maxAttempts);
  const queue = new Map<string, { id: string; title: string; url: string | null; last_edited: string | null; retry: boolean }>();
  for (const c of candidates) queue.set(c.record_id, { id: c.record_id, title: c.title, url: c.url ?? null, last_edited: c.last_edited ?? null, retry: false });
  for (const d of retryable) {
    const q = queue.get(d.source_id);
    if (q) q.retry = true;
    else queue.set(d.source_id, { id: d.source_id, title: d.title, url: d.url, last_edited: null, retry: true });
  }

  // 2-4. Fetch, persist, compare hashes.
  let fetched = 0;
  for (const item of queue.values()) {
    const stored = await writer.getDoc("notion", ws, item.id);
    // The source says it has not been edited since the stored version was read: nothing to fetch.
    if (stored && !item.retry && stored.sync_status === "synced" && !stored.archived && stored.last_edited && item.last_edited && stored.last_edited === item.last_edited) { report.skipped += 1; continue; }
    // A source that has failed `maxAttempts` times is left for a person to look at (it stays visible as failed); it is not read again every run.
    if (stored && stored.sync_status === "failed" && stored.attempts >= maxAttempts) { report.skipped += 1; continue; }
    if (fetched >= maxDocs) { report.skipped += 1; continue; }
    fetched += 1;
    if (item.retry) report.retried += 1;
    let read;
    try { read = await notion.readMeetingDocument(item.id); } catch { read = { ok: false as const, reason: "error" as const }; }
    if (!read.ok) { await writer.recordFailure("notion", ws, item.id, { title: item.title, url: item.url }, code(read.reason), clock().toISOString()); report.failed += 1; continue; }
    const doc = sanitizeDocument(read.data);
    try {
      const { change } = await writer.upsertDoc({
        provider: "notion", workspace_id: ws, source_id: item.id, url: doc.url ?? item.url, title: doc.title, doc_type: "page", segments: doc.segments, coverage: doc.coverage,
        last_edited: doc.last_edited ?? item.last_edited, owner: null, ingested_at: clock().toISOString(),
      });
      report[change] += 1;
    } catch {
      await writer.recordFailure("notion", ws, item.id, { title: item.title, url: item.url }, "error", clock().toISOString());
      report.failed += 1;
    }
  }

  // A source that has disappeared from a COMPLETE listing is archived (and its records marked stale); a partial listing proves nothing.
  if (!report.discovery_failure && listingComplete) {
    const present = new Set(candidates.map((c) => c.record_id));
    for (const id of await writer.listActiveSourceIds("notion", ws)) if (!present.has(id)) { await writer.archiveDoc("notion", ws, id); report.archived += 1; }
  }

  // 5-7. Extract, validate and persist L1 for every document whose current content has no extraction yet.
  if (extractor) {
    const pending = (await writer.listUnextracted("notion", ws)).slice(0, opts.maxExtract ?? DEFAULT_MAX_EXTRACT);
    for (const doc of pending) {
      const result = await extractor.extract(doc);
      if (!result.ok) { await writer.markExtracted(doc.id, doc.content_hash, "extraction_failed"); report.extraction_failed += 1; continue; }
      const checked = validateExtraction(doc, result.raw);
      // The model may have seen only the start of a long document. What it found is stored, but it cannot prove what the rest no longer states, so no record is marked stale.
      let partial = result.truncated;
      const stored = await writer.upsertEntities(doc.id, checked.entities, clock().toISOString(), { reconcile: !result.truncated });
      report.entities_created += stored.created; report.entities_updated += stored.updated; report.entities_staled += stored.staled;
      report.entities_rejected += checked.rejected; report.owners_dropped += checked.owners_dropped; report.dates_dropped += checked.dates_dropped;
      // Phase 2B: relationships between this document's entities. If this step fails the document stays unextracted, so the next run retries it
      // (entity upsert is idempotent; reviewed entities and relationships are never overwritten).
      if (deps.relationshipExtractor) {
        const entities = await writer.listDocEntities(doc.id);
        const rel = await deps.relationshipExtractor.extract(doc, entities);
        if (!rel.ok) { await writer.markExtracted(doc.id, doc.content_hash, "extraction_failed"); report.relationship_extraction_failed += 1; continue; }
        const vr = validateRelationships(doc, entities, rel.raw);
        if (rel.truncated) partial = true;
        try {
          const rs = await writer.upsertRelationships(doc.id, vr.relationships, clock().toISOString(), { reconcile: !rel.truncated });
          report.relationships_created += rs.created; report.relationships_updated += rs.updated; report.relationships_staled += rs.staled;
        } catch {
          await writer.markExtracted(doc.id, doc.content_hash, "extraction_failed"); report.relationship_extraction_failed += 1; continue;
        }
        report.relationships_rejected += vr.rejected; report.relationships_downgraded += vr.downgraded;
      }
      if (partial) report.reconcile_skipped_truncated += 1;
      await writer.markExtracted(doc.id, doc.content_hash, null);
      report.extracted_docs += 1;
    }
  }

  return report;
}
