import type { AiReviewInput } from "@/lib/backend/types";
import { TASK_PRIORITIES, type TaskPriority } from "@/lib/types";

/**
 * Validates what the browser sends for an AI-inbox decision. Everything here is untrusted: it is
 * a plain object from a server-action call, not necessarily from our form. The reviewer identity is
 * never part of it (it comes from the session) and neither are status, owner rules or task fields.
 */
export function parseAiReviewInput(raw: unknown): { input: AiReviewInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "Invalid request." };
  const o = raw as Record<string, unknown>;
  if (o.action === "reject") return { input: { action: "reject" } };
  if (o.action !== "approve") return { error: "Invalid request." };

  const out: Extract<AiReviewInput, { action: "approve" }> = { action: "approve" };
  if (o.assigned_to !== undefined) {
    if (o.assigned_to !== null && (typeof o.assigned_to !== "string" || o.assigned_to.length > 64)) return { error: "Invalid assignee." };
    out.assigned_to = o.assigned_to === "" ? null : (o.assigned_to as string | null);
  }
  if (o.priority !== undefined && o.priority !== "") {
    if (typeof o.priority !== "string" || !TASK_PRIORITIES.includes(o.priority as TaskPriority)) return { error: "Invalid priority." };
    out.priority = o.priority as TaskPriority;
  }
  if (o.due_at !== undefined) {
    if (o.due_at === null || o.due_at === "") out.due_at = null;
    else if (typeof o.due_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.due_at) && !Number.isNaN(Date.parse(o.due_at))) out.due_at = new Date(o.due_at).toISOString();
    else return { error: "Enter a valid date." };
  }
  return { input: out };
}

export const isValidDedupeKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 400;
