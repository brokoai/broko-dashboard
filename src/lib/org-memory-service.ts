import type { Extractor } from "@/lib/ai-brain/org-memory/extract";
import type { RelationshipExtractor } from "@/lib/ai-brain/org-memory/extract-relationships";
import { runIngestion } from "@/lib/ai-brain/org-memory/ingest";
import type { IngestRunReport, RunStatus } from "@/lib/ai-brain/org-memory/types";
import type { NotionConnector } from "@/lib/ai-brain/assistant/connectors";
import type { Backend, Repo } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";

/**
 * The controlled path that fills organizational memory. Free of Next.js so it can be tested directly (like chat-service.ts).
 *
 *   signed-in user (server session) -> administrator check -> ONE run at a time (database slot) -> existing ingestion pipeline -> counts recorded
 *
 * The role comes from the server-validated profile, never from the request. Everything runs as the signed-in administrator's own session: there is no
 * service-role path and no unauthenticated entry. A run is bounded (pages fetched, pages extracted, retry limit) and idempotent, so repeating it is safe.
 */

export type IngestOutcome =
  | { ok: true; status: RunStatus; report: IngestRunReport }
  | { ok: false; error: "unauthenticated" | "forbidden" | "unavailable" | "busy" | "failed"; message: string };

export interface IngestServiceDeps {
  user: Profile | null;
  backendKind: Backend["kind"];
  repoFor: (user: Profile) => Promise<Repo>;
  /** Built for THIS user by the caller (same selection as the chat). Null = Notion is not connected. */
  notion: NotionConnector | null;
  /** Null = the model is not configured: documents are stored (L0) but nothing is extracted. */
  extractor: Extractor | null;
  /** Phase 2B. Null/absent = entities are extracted but no relationships. */
  relationshipExtractor?: RelationshipExtractor | null;
  workspaceId: string;
  now?: () => Date;
  maxDocs?: number;
  maxExtract?: number;
  maxAttempts?: number;
  log?: (e: unknown) => void;
}

const MESSAGES = {
  unauthenticated: "Please sign in again.",
  forbidden: "Only administrators can update organizational memory.",
  unavailable: "Organizational memory is not available here.",
  busy: "An update is already running. Try again in a few minutes.",
  failed: "The update could not be completed.",
} as const;
const no = (error: keyof typeof MESSAGES): IngestOutcome => ({ ok: false, error, message: MESSAGES[error] });

/** Counts only: no titles, ids or text. These are what is stored with the run. */
const flat = (r: IngestRunReport): Record<string, number | string | null> => ({ ...r });

export async function handleIngest(deps: IngestServiceDeps): Promise<IngestOutcome> {
  const { user } = deps;
  if (!user) return no("unauthenticated");
  if (user.role !== "admin") return no("forbidden");
  if (deps.backendKind !== "supabase") return no("unavailable"); // the demo never reaches Notion for this and has nowhere durable to write
  if (!deps.notion) return no("unavailable");
  let repo: Repo;
  try { repo = await deps.repoFor(user); } catch (e) { (deps.log ?? console.error)("[org-memory] repo", e); return no("failed"); }
  const memory = repo.orgMemory;
  if (!memory) return no("unavailable");

  let started;
  try { started = await memory.runs.start(); } catch (e) { (deps.log ?? console.error)("[org-memory] start", e); return no("failed"); }
  if (!started.ok) return no(started.reason === "busy" ? "busy" : "forbidden");

  let report: IngestRunReport | null = null;
  try {
    report = await runIngestion(
      { notion: deps.notion, writer: memory.writer, extractor: deps.extractor, relationshipExtractor: deps.relationshipExtractor ?? null },
      { workspaceId: deps.workspaceId, now: deps.now, maxDocs: deps.maxDocs, maxExtract: deps.maxExtract, maxAttempts: deps.maxAttempts },
    );
    const status: RunStatus = report.discovery_failure ? "failed" : report.failed > 0 || report.extraction_failed > 0 || report.relationship_extraction_failed > 0 ? "partial" : "ok";
    await memory.runs.finish(started.id, status, flat(report));
    return { ok: true, status, report };
  } catch (e) {
    (deps.log ?? console.error)("[org-memory] run", e);
    try { await memory.runs.finish(started.id, "failed", report ? flat(report) : {}); } catch { /* the slot expires on its own after 15 minutes */ }
    return no("failed");
  }
}
