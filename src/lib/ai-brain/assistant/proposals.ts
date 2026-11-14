import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Profile } from "@/lib/types";

/**
 * Action proposals: the typed hand-off between "the Assistant suggests a change" and "a person approves exactly that change".
 *
 * PHASE 1 BOUNDARY: proposals are prepared and displayed only. They are not stored anywhere (no table, no migration), so they cannot
 * be approved from the chat, and nothing here executes anything: `executeProposal` runs only a registered executor, none is registered,
 * and it refuses anything that is not approved, unexpired and byte-for-byte the parameters that were approved.
 */

export const PROPOSAL_TYPES = [
  "create_task", "assign_task", "update_task", "delete_record", "send_email", "create_calendar_event", "update_calendar_event",
  "update_notion_page", "review_ai_message", "change_configuration",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];
export type TargetSystem = "broko_tasks" | "broko_ai_inbox" | "broko_settings" | "outlook_mail" | "outlook_calendar" | "notion";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";
export type ExecutionState = "not_executed" | "executing" | "executed" | "failed";

export const PROPOSAL_TARGETS: Record<ProposalType, TargetSystem> = {
  create_task: "broko_tasks", assign_task: "broko_tasks", update_task: "broko_tasks", delete_record: "broko_tasks",
  send_email: "outlook_mail", create_calendar_event: "outlook_calendar", update_calendar_event: "outlook_calendar",
  update_notion_page: "notion", review_ai_message: "broko_ai_inbox", change_configuration: "broko_settings",
};
const LABEL: Record<ProposalType, string> = {
  create_task: "Create a task", assign_task: "Assign a task", update_task: "Change a task", delete_record: "Delete a record",
  send_email: "Send an email", create_calendar_event: "Create a calendar event", update_calendar_event: "Change or delete a calendar event",
  update_notion_page: "Modify a Notion page", review_ai_message: "Approve or reject an AI Inbox message", change_configuration: "Change configuration",
};

/** Per-type parameter schemas. Phase 1 knows only the requester own words; later phases add typed fields (recipients, times, ids). */
const Params = z.object({ request_text: z.string().trim().min(1).max(200) }).strict();
export const PARAMETER_SCHEMAS: Record<ProposalType, z.ZodType<Record<string, string>>> = Object.fromEntries(PROPOSAL_TYPES.map((t) => [t, Params])) as never;

export interface ActionProposal {
  id: string;
  requested_by: string;
  type: ProposalType;
  target: TargetSystem;
  parameters: Record<string, string>;
  /** Hash of type + target + parameters. Approval is bound to this value, so it cannot be reused for a different action. */
  parameters_digest: string;
  description: string;
  created_at: string;
  expires_at: string;
  approval: ApprovalState;
  execution: ExecutionState;
  result_ref: string | null;
  /** True only when the parameters are complete enough to execute. Chat-derived Phase 1 proposals are never complete. */
  executable: boolean;
}

export const PROPOSAL_TTL_MS = 15 * 60_000;

export function digestOf(type: ProposalType, target: TargetSystem, parameters: Record<string, string>): string {
  const sorted = Object.keys(parameters).sort().map((k) => [k, parameters[k]]);
  return createHash("sha256").update(JSON.stringify([type, target, sorted])).digest("hex");
}

export type PrepareResult = { ok: true; proposal: ActionProposal } | { ok: false; reason: "invalid_type" | "invalid_parameters" | "not_signed_in" };

/** Prepares a proposal. Creates no record, calls no system, and the result is always pending / not_executed. */
export function prepareProposal(user: Profile | null, type: string, rawParameters: unknown, now: Date, ttlMs = PROPOSAL_TTL_MS): PrepareResult {
  if (!user) return { ok: false, reason: "not_signed_in" };
  if (!(PROPOSAL_TYPES as readonly string[]).includes(type)) return { ok: false, reason: "invalid_type" };
  const t = type as ProposalType;
  const parsed = PARAMETER_SCHEMAS[t].safeParse(rawParameters);
  if (!parsed.success) return { ok: false, reason: "invalid_parameters" };
  const target = PROPOSAL_TARGETS[t];
  return {
    ok: true,
    proposal: {
      id: randomUUID(), requested_by: user.id, type: t, target, parameters: parsed.data,
      parameters_digest: digestOf(t, target, parsed.data),
      description: `${LABEL[t]} (draft request, details not yet specified). Nothing has been done.`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + Math.max(1, ttlMs)).toISOString(),
      approval: "pending", execution: "not_executed", result_ref: null, executable: false,
    },
  };
}

/** A pending proposal past its expiry is expired; nothing else changes with time. */
export const effectiveApproval = (p: ActionProposal, now: Date): ApprovalState => (p.approval === "pending" && now.getTime() >= Date.parse(p.expires_at) ? "expired" : p.approval);

export type DecisionResult = { ok: true; proposal: ActionProposal } | { ok: false; reason: "not_requester" | "not_pending" | "expired" | "digest_mismatch" };

/**
 * Records a person decision on a proposal. Only the requester decides, only while pending and unexpired, and approval must quote the
 * digest of the exact parameters: approving one action can never authorize another. It does NOT execute anything.
 */
export function decideProposal(p: ActionProposal, by: Profile, decision: "approve" | "reject", digest: string, now: Date): DecisionResult {
  if (by.id !== p.requested_by) return { ok: false, reason: "not_requester" };
  const state = effectiveApproval(p, now);
  if (state === "expired") return { ok: false, reason: "expired" };
  if (state !== "pending") return { ok: false, reason: "not_pending" };
  if (digest !== p.parameters_digest || digestOf(p.type, p.target, p.parameters) !== p.parameters_digest) return { ok: false, reason: "digest_mismatch" };
  return { ok: true, proposal: { ...p, approval: decision === "approve" ? "approved" : "rejected" } };
}

export type Executor = (p: ActionProposal) => Promise<{ result_ref: string }>;
export type ExecuteResult = { ok: true; proposal: ActionProposal } | { ok: false; reason: "not_approved" | "expired" | "digest_mismatch" | "not_executable" | "no_executor" | "already_run" | "failed" };

/** Phase 1 registers none. Kept so the gate is tested now and a later phase adds executors without changing the rules. */
export const NO_EXECUTORS: Partial<Record<ProposalType, Executor>> = Object.freeze({});

export async function executeProposal(p: ActionProposal, now: Date, executors: Partial<Record<ProposalType, Executor>> = NO_EXECUTORS): Promise<ExecuteResult> {
  if (p.execution !== "not_executed") return { ok: false, reason: "already_run" };
  if (p.approval !== "approved") return { ok: false, reason: "not_approved" };
  if (now.getTime() >= Date.parse(p.expires_at)) return { ok: false, reason: "expired" };
  if (digestOf(p.type, p.target, p.parameters) !== p.parameters_digest) return { ok: false, reason: "digest_mismatch" };
  if (!p.executable) return { ok: false, reason: "not_executable" };
  const run = executors[p.type];
  if (!run) return { ok: false, reason: "no_executor" };
  try {
    const { result_ref } = await run({ ...p, execution: "executing" });
    return { ok: true, proposal: { ...p, execution: "executed", result_ref } };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
