import type { Task } from "@/lib/types";

// Due dates are calendar dates, handled in UTC so server and client always agree.
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const todayKey = () => dayKey(new Date());

export const isActive = (t: Pick<Task, "status">) => t.status === "open" || t.status === "in_progress";
/** The `...On` variants take the reference day explicitly (used where the clock must be injectable, e.g. the AI chat). */
export const isDueOn = (t: Pick<Task, "status" | "due_at">, day: string) => isActive(t) && !!t.due_at && dayKey(new Date(t.due_at)) === day;
export const isOverdueOn = (t: Pick<Task, "status" | "due_at">, day: string) => isActive(t) && !!t.due_at && dayKey(new Date(t.due_at)) < day;
export const isDueToday = (t: Task) => isDueOn(t, todayKey());
export const isOverdue = (t: Task) => isOverdueOn(t, todayKey());

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC";
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export const dateInputValue = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}
