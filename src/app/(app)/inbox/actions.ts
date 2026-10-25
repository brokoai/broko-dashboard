"use server";

import { revalidatePath } from "next/cache";
import { getRepo, requireUser } from "@/lib/auth";
import { UserFacingError } from "@/lib/backend/types";
import { isValidJobId } from "@/lib/ai-brain/jobs";
import { isValidReviewId, parseAiReviewInput } from "@/lib/ai-review-input";

export interface ReviewActionResult {
  ok?: boolean;
  error?: string;
  taskId?: string | null;
  /** The decision was saved but something secondary (its audit event) was not. Never hidden. */
  warning?: string;
}

function toMessage(e: unknown, fallback: string): string {
  if (e instanceof UserFacingError) return e.message;
  console.error("[ai-inbox]", e);
  return fallback;
}

/** Approve or reject an AI-proposed task. Authorization lives in the backend; this only validates and relays. */
export async function reviewAiMessage(reviewId: string, raw: unknown): Promise<ReviewActionResult> {
  const user = await requireUser(); // authenticate before touching any input
  if (!isValidReviewId(reviewId)) return { error: "Invalid request." };
  const parsed = parseAiReviewInput(raw);
  if ("error" in parsed) return { error: parsed.error };
  try {
    const repo = await getRepo(user);
    if (!repo.aiInbox) return { error: "The AI Inbox is not connected to this backend." };
    const result = await repo.aiInbox.review(reviewId, parsed.input);
    if (!result.ok) return { error: result.message };
    revalidatePath("/", "layout");
    return {
      ok: true, taskId: result.record.task_id,
      warning: result.audit_ok ? undefined : "The decision was saved, but its audit event could not be recorded.",
    };
  } catch (e) {
    return { error: toMessage(e, "Could not complete the review. Please try again.") };
  }
}

/** Runs the background worker once over whatever is due (administrators only). Classification never happens while a page renders. */
export async function processAiQueue(): Promise<{ ok?: boolean; error?: string; completed?: number; retried?: number; failed?: number }> {
  const user = await requireUser();
  try {
    const repo = await getRepo(user);
    if (!repo.aiInbox) return { error: "The AI Inbox is not connected to this backend." };
    const r = await repo.aiInbox.process();
    revalidatePath("/inbox");
    return { ok: true, ...r };
  } catch (e) {
    return { error: toMessage(e, "Could not process the queue. Please try again.") };
  }
}

/** Puts a failed job back in the queue (administrators only; the backend records who did it). */
export async function requeueAiJob(jobId: string): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireUser();
  if (!isValidJobId(jobId)) return { error: "Invalid request." };
  try {
    const repo = await getRepo(user);
    if (!repo.aiInbox) return { error: "The AI Inbox is not connected to this backend." };
    if (!(await repo.aiInbox.requeue(jobId))) return { error: "Only a failed job can be retried." };
    revalidatePath("/inbox");
    return { ok: true };
  } catch (e) {
    return { error: toMessage(e, "Could not retry the job. Please try again.") };
  }
}
