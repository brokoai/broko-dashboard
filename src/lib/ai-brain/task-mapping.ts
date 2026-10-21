import { createHash } from "node:crypto";
import type { TaskInput, TaskPriority } from "@/lib/types";
import type { ProcessedMessage } from "./schema";

/** Short, stable, non-reversible reference shown on the task (never the raw message id). */
export const sourceRef = (dedupeKey: string) => createHash("sha256").update(dedupeKey).digest("hex").slice(0, 12);

export interface TaskOverrides {
  assigned_to?: string | null;
  due_at?: string | null;
  priority?: TaskPriority;
}

/**
 * Builds the input for the EXISTING task model (no second task system). Plain text only. The
 * backend sets source = "email" and external_reference = the dedupe key server-side; they are
 * not caller-controlled fields.
 */
export function buildTaskInput(record: ProcessedMessage, overrides: TaskOverrides = {}): TaskInput {
  const a = record.analysis;
  const title = (a?.proposed_task?.title ?? `Follow up: ${record.subject}`).trim().slice(0, 120);
  const lines: string[] = [];
  if (a) {
    lines.push(`Summary: ${a.summary}`);
    if (a.requested_action) lines.push(`Requested: ${a.requested_action}`);
    const c = a.contact;
    const contact = [c.name && `name ${c.name}`, c.email && `email ${c.email}`, c.phone && `phone ${c.phone}`].filter(Boolean).join(", ");
    if (contact) lines.push(`Contact (as stated in the message): ${contact}`);
    if (a.property_reference) lines.push(`Property reference: ${a.property_reference}`);
    if (a.requested_date) lines.push(`Date mentioned: ${a.requested_date.date}`);
    if (a.missing_information.length) lines.push(`Missing: ${a.missing_information.join(", ").replace(/_/g, " ")}`);
    if (a.clarification_question) lines.push(`Suggested question to the sender: ${a.clarification_question}`);
    if (a.proposed_task?.description) lines.push("", a.proposed_task.description);
  }
  lines.push("", `Source: email from ${record.sender_email}, received ${record.received_at}. Reference ${sourceRef(record.dedupe_key)}.`);
  lines.push("Created from an AI-assisted analysis. Verify the details and the sender before acting; no reply has been sent.");
  return {
    title,
    description: lines.join("\n").slice(0, 4000),
    status: "open",
    priority: overrides.priority ?? record.proposed_priority ?? "medium",
    assigned_to: overrides.assigned_to !== undefined ? overrides.assigned_to : record.owner.user_id,
    due_at: overrides.due_at !== undefined ? overrides.due_at : record.proposed_due_at,
  };
}
