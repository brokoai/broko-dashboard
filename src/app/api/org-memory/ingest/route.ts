import { NextResponse } from "next/server";
import { connectorsFor } from "@/lib/ai-brain/assistant/brain-tools";
import { createAnthropicExtractor } from "@/lib/ai-brain/org-memory/extract";
import { createAnthropicRelationshipExtractor } from "@/lib/ai-brain/org-memory/extract-relationships";
import { loadAiBrainConfig } from "@/lib/ai-brain";
import { createToolTransport } from "@/lib/ai-brain/model-tool-transport";
import { getRepo } from "@/lib/auth";
import { getBackend } from "@/lib/backend";
import { relationshipsEnabled } from "@/lib/ai-brain/assistant/memory-tools";
import { handleIngest } from "@/lib/org-memory-service";

/**
 * Administrator-only ingestion of organizational memory. POST only, no body.
 *   - The proxy already requires a session; this handler re-validates it and the ADMINISTRATOR role on the server (the profile row, never the request).
 *   - A custom header is required. Browsers cannot attach it cross-site without a CORS preflight (which this route never answers), so a forged
 *     cross-site form post cannot start a run.
 *   - One run at a time (database slot), bounded pages and extractions, nothing returned but counts.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HEADER = "x-broko-org-memory";

export async function POST(request: Request): Promise<NextResponse> {
  if (request.headers.get(HEADER) !== "ingest") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const backend = await getBackend();
  const user = await backend.getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const repo = await getRepo(user);
  const cfg = loadAiBrainConfig(process.env);
  const transport = createToolTransport(cfg, { timeoutMs: 60_000 });
  const outcome = await handleIngest({
    user, backendKind: backend.kind, repoFor: async () => repo,
    notion: connectorsFor({ user, mode: backend.kind === "demo" ? "demo" : "live", repo, now: new Date() }).notion,
    extractor: transport ? createAnthropicExtractor({ transport }) : null,
    relationshipExtractor: transport && relationshipsEnabled(process.env) ? createAnthropicRelationshipExtractor({ transport }) : null,
    workspaceId: process.env.NOTION_WORKSPACE_ID?.trim() || "default",
  });
  if (outcome.ok) return NextResponse.json({ status: outcome.status, report: outcome.report });
  const status = outcome.error === "busy" ? 409 : outcome.error === "forbidden" ? 403 : outcome.error === "unauthenticated" ? 401 : outcome.error === "unavailable" ? 503 : 500;
  return NextResponse.json({ error: outcome.error, message: outcome.message }, { status });
}
