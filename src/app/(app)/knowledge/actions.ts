"use server";

import { revalidatePath } from "next/cache";
import { UserFacingError } from "@/lib/backend/types";
import { previewKnowledge, reviewKnowledge, sendFeedback, submitKnowledge, type SubmissionPreview } from "@/lib/knowledge/service";
import { knowledgeContext } from "./_lib";

// Thin wrappers: authenticate first (the session decides who the user is), run the tested service, and turn failures into
// messages. UserFacingError text is shown; anything else is logged on the server and replaced by a generic sentence. The browser
// sends only the fields of the form; status, author, reviewer and timestamps are never accepted from it (the schemas are strict).

export type KnowledgeActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown, fallback: string): { ok: false; error: string } {
  if (e instanceof UserFacingError) return { ok: false, error: e.message };
  console.error("[knowledge]", e);
  return { ok: false, error: fallback };
}

const refresh = () => revalidatePath("/knowledge");

/** Validates and previews a submission. Writes NOTHING. */
export async function previewKnowledgeAction(raw: unknown): Promise<KnowledgeActionResult<{ preview: SubmissionPreview }>> {
  const ctx = await knowledgeContext();
  try {
    return { ok: true, preview: await previewKnowledge(ctx, raw) };
  } catch (e) {
    return fail(e, "The preview could not be created. Please try again.");
  }
}

/** Creates a PROPOSAL. It is not used in answers until an administrator approves it. */
export async function submitKnowledgeAction(raw: unknown): Promise<KnowledgeActionResult> {
  const ctx = await knowledgeContext();
  try {
    await submitKnowledge(ctx, raw);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "Your submission could not be saved. Please try again.");
  }
}

/** Administrators only (checked again by the service, the repository and the database). */
export async function reviewKnowledgeAction(raw: unknown): Promise<KnowledgeActionResult> {
  const ctx = await knowledgeContext();
  try {
    await reviewKnowledge(ctx, raw);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "That change could not be saved. Please try again.");
  }
}

/** Metadata-only feedback about an answer. Best effort: a failure never affects the chat. */
export async function sendFeedbackAction(raw: unknown): Promise<KnowledgeActionResult> {
  const ctx = await knowledgeContext();
  try {
    await sendFeedback(ctx, raw);
    return { ok: true };
  } catch (e) {
    return fail(e, "Your feedback could not be saved.");
  }
}
