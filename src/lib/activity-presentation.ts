import type { ActivityEvent, EventType } from "@/lib/types";

/** Pure presentation rules for the Activity feed, kept free of React so they are testable and cannot crash a page. */
export type Tone = "neutral" | "red" | "amber" | "blue" | "green";

export const KNOWN_EVENT_TYPES: readonly EventType[] = [
  "email_received", "message_classified", "potential_task_identified", "task_created", "task_assigned", "task_updated", "task_completed",
  "notification_sent", "workflow_failed",
];

export const isKnownEventType = (t: string): t is EventType => (KNOWN_EVENT_TYPES as readonly string[]).includes(t);

export function statusBadge(status: string): { label: string; tone: Tone } {
  if (status === "processed") return { label: "Processed", tone: "green" };
  if (status === "pending") return { label: "Pending", tone: "amber" };
  if (status === "failed") return { label: "Failed", tone: "red" };
  return { label: "Unknown", tone: "neutral" }; // a status this build does not know still renders
}

/** Extra badges for AI workflow events. Plain task events (no metadata) get none. */
export function aiBadges(e: Pick<ActivityEvent, "metadata">): { label: string; tone: Tone }[] {
  const md = e.metadata;
  if (!md) return [];
  const out: { label: string; tone: Tone }[] = [];
  if (md.decision) out.push({ label: md.decision === "approved" ? "Approved" : "Rejected", tone: md.decision === "approved" ? "green" : "neutral" });
  if (md.classifier_mode) out.push({ label: md.fallback_reason ? "Rules (fallback)" : md.classifier_mode === "llm" ? "AI model" : "Rules", tone: "blue" });
  if (md.flags.length > 0) out.push({ label: `${md.flags.length} risk flag${md.flags.length === 1 ? "" : "s"}`, tone: "amber" });
  return out;
}
