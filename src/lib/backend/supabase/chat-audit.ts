import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatAuditWriter } from "@/lib/ai-brain/chat/audit";

// Verified against the development Supabase project (broko-dev) on 2026-10-28; NOT verified against Production.
// Runs as the signed-in user: supabase/proposed/0008_chat_audit.proposed.sql only lets them
// insert a row as themself, and only these columns. The row holds metadata only; there is no column for message or answer text.
export function createSupabaseChatAudit(db: SupabaseClient, userId: string): ChatAuditWriter {
  return {
    async record(e) {
      // No .select(): the caller needs no row back, and the table grants no more than it must.
      const { error } = await db.from("chat_audit").insert({ ...e, actor_id: userId });
      if (error) throw new Error(error.message);
    },
  };
}
