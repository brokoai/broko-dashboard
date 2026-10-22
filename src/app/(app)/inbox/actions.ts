"use server";

import { revalidatePath } from "next/cache";
import { getRepo, requireUser } from "@/lib/auth";
import { UserFacingError } from "@/lib/backend/types";
import { isValidDedupeKey, parseAiReviewInput } from "@/lib/ai-review-input";

export interface ReviewActionResult { ok?: boolean; error?: string; taskId?: string | null }

/** Approve or reject an AI-proposed task. Authorization lives in the backend; this only validates and relays. */
export async function reviewAiMessage(dedupeKey: string, raw: unknown): Promise<ReviewActionResult> {
  const user = await requireUser(); // authenticate before touching any input
  if (!isValidDedupeKey(dedupeKey)) return { error: "Invalid request." };
  const parsed = parseAiReviewInput(raw);
  if ("error" in parsed) return { error: parsed.error };
  try {
    const repo = await getRepo(user);
    if (!repo.aiInbox) return { error: "The AI Inbox is not connected to this backend." };
    const result = await repo.aiInbox.review(dedupeKey, parsed.input);
    if (!result.ok) return { error: result.message };
    revalidatePath("/", "layout");
    return { ok: true, taskId: result.record.task_id };
  } catch (e) {
    if (e instanceof UserFacingError) return { error: e.message };
    console.error("[ai-inbox]", e);
    return { error: "Could not complete the review. Please try again." };
  }
}
