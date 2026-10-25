import type { AiInboxCounts, AiInboxCountsReader } from "../types";
import type { AI_MESSAGE_COLUMNS } from "./ai-contract";

// NOT WIRED INTO THE SUPABASE BACKEND AND NOT VERIFIED AGAINST A LIVE DATABASE.
// It needs migration 0003 (public.ai_messages) and an owner decision to enable it; until then `Repo.aiInboxCounts` is absent on
// Supabase and chat reports the AI Inbox as "not connected". See docs/ai-brain/AI_INBOX_READINESS.md.

/** The ONLY column this reader selects. Typed against the contract so a rename breaks the build. */
export const COUNTS_COLUMN: (typeof AI_MESSAGE_COLUMNS)[number] = "status";

/** Above this many messages the tally would be incomplete, so the read fails instead of undercounting. */
export const COUNTS_ROW_LIMIT = 10_000;

/** The slice of the Supabase client this reader uses: `from(table).select(columns).limit(n)`. */
export interface CountsClient {
  from(table: "ai_messages"): {
    select(columns: string): { limit(n: number): PromiseLike<{ data: { status?: unknown }[] | null; error: { message: string } | null }> };
  };
}

/**
 * Counts AI Inbox messages per status as the signed-in user. Administrators only: the role check runs BEFORE any query, so a
 * member causes no database read and learns nothing; RLS on ai_messages (admin-only select) is the second, independent line.
 */
export function createSupabaseAiInboxCounts(db: CountsClient, user: { role: "admin" | "member" }): AiInboxCountsReader {
  return {
    async counts(): Promise<AiInboxCounts> {
      if (user.role !== "admin") throw new Error("AI Inbox counts are for administrators only.");
      const { data, error } = await db.from("ai_messages").select(COUNTS_COLUMN).limit(COUNTS_ROW_LIMIT);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      if (rows.length >= COUNTS_ROW_LIMIT) throw new Error("Too many AI Inbox messages to count safely.");
      const by_status: Record<string, number> = {};
      for (const r of rows) {
        if (typeof r.status !== "string") continue; // an unexpected row shape is ignored, never guessed at
        by_status[r.status] = (by_status[r.status] ?? 0) + 1;
      }
      return { mode: "live", by_status, total: Object.values(by_status).reduce((a, b) => a + b, 0) };
    },
  };
}
