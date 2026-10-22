import { randomBytes } from "node:crypto";
import type { ActivityEvent, Task, TaskPriority, TaskStatus } from "@/lib/types";
import { STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES } from "@/lib/types";
import { DEMO_USERS } from "./users";

/**
 * Per-visitor demo data. Sample data is regenerated deterministically on every request;
 * only the visitor's CHANGES are stored (in a signed cookie), in a compact, bounded,
 * strictly validated form. Synthetic data only; no secrets.
 */
export const LIMITS = {
  tasks: 6,          // changed-or-new tasks kept per visitor
  events: 8,
  aiMessages: 16,    // synthetic AI-inbox messages (rejections are stored by index)
  title: 80,
  description: 120,
  /** Max UTF-8 bytes of the JSON payload. Signed + base64 this stays well under the 4 KB cookie limit. */
  maxEncodedBytes: 2800,
} as const;

const KINDS = ["task_created", "task_assigned", "task_updated", "task_completed"] as const;
type Kind = (typeof KINDS)[number];
const USER_IDS = DEMO_USERS.map((u) => u.id);
const DAY = 86_400_000;
const ID_RE = /^[a-z0-9]{2,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** [id, title, description, status, priority, assignee(-1 none), due "YYYY-MM-DD"|"", creator, created, updated, completed(0 none)] — times in epoch seconds */
export type StoredTask = [string, string, string, number, number, number, string, number, number, number, number];
/** [kind, taskId, ts(sec), actor, fromStatus(-1), toStatus(-1)] */
export type StoredEvent = [number, string, number, number, number, number];
/** `r`: indexes of synthetic AI-inbox messages a reviewer rejected (approvals are the tasks themselves). */
export interface DemoState { t: StoredTask[]; e: StoredEvent[]; r: number[] }

export const emptyState = (): DemoState => ({ t: [], e: [], r: [] });
export const newTaskId = (): string => `n${randomBytes(5).toString("hex")}`;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function parseTask(x: unknown): StoredTask | null {
  if (!Array.isArray(x) || x.length !== 11) return null;
  const [id, title, desc, st, pr, as, due, cr, c, u, d] = x as unknown[];
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (typeof title !== "string" || title.length < 1 || title.length > LIMITS.title) return null;
  if (typeof desc !== "string" || desc.length > LIMITS.description) return null;
  if (!isInt(st, 0, TASK_STATUSES.length - 1) || !isInt(pr, 0, TASK_PRIORITIES.length - 1)) return null;
  if (!isInt(as, -1, USER_IDS.length - 1) || !isInt(cr, 0, USER_IDS.length - 1)) return null;
  if (typeof due !== "string" || (due !== "" && (!DATE_RE.test(due) || Number.isNaN(Date.parse(due))))) return null;
  if (!isInt(c, 0, 4e9) || !isInt(u, 0, 4e9) || !isInt(d, 0, 4e9)) return null;
  return [id, title, desc, st, pr, as, due, cr, c, u, d];
}

function parseEvent(x: unknown): StoredEvent | null {
  if (!Array.isArray(x) || x.length !== 6) return null;
  const [k, id, ts, actor, from, to] = x as unknown[];
  if (!isInt(k, 0, KINDS.length - 1) || typeof id !== "string" || !ID_RE.test(id)) return null;
  if (!isInt(ts, 0, 4e9) || !isInt(actor, 0, USER_IDS.length - 1)) return null;
  if (!isInt(from, -1, TASK_STATUSES.length - 1) || !isInt(to, -1, TASK_STATUSES.length - 1)) return null;
  return [k, id, ts, actor, from, to];
}

/** Never throws: anything malformed or oversized yields the valid part (or an empty state). */
export function decodeState(raw: string | null | undefined): DemoState {
  if (!raw || Buffer.byteLength(raw) > 16_000) return emptyState();
  try {
    const o = JSON.parse(raw) as { t?: unknown; e?: unknown; r?: unknown };
    const seen = new Set<string>();
    const t = (Array.isArray(o.t) ? o.t : []).slice(0, LIMITS.tasks).map(parseTask)
      .filter((x): x is StoredTask => x !== null && !seen.has(x[0]) && !!seen.add(x[0]));
    const e = (Array.isArray(o.e) ? o.e : []).slice(-LIMITS.events).map(parseEvent).filter((x): x is StoredEvent => x !== null);
    const r = [...new Set((Array.isArray(o.r) ? o.r : []).filter((n): n is number => isInt(n, 0, LIMITS.aiMessages - 1)))].slice(0, LIMITS.aiMessages);
    return { t, e, r };
  } catch {
    return emptyState();
  }
}

export const encodeState = (s: DemoState): string => JSON.stringify(s.r.length ? { t: s.t, e: s.e, r: s.r } : { t: s.t, e: s.e });
export const encodedSize = (s: DemoState): number => Buffer.byteLength(encodeState(s));

// ---------------------------------------------------------------- sample data
const idx = (id: string | null) => (id === null ? -1 : USER_IDS.indexOf(id));
const nameAt = (i: number) => (i < 0 ? null : DEMO_USERS[i].full_name);
const secToIso = (s: number) => new Date(s * 1000).toISOString();

export function toTuple(t: Task): StoredTask {
  return [
    t.id, t.title, t.description ?? "", TASK_STATUSES.indexOf(t.status), TASK_PRIORITIES.indexOf(t.priority),
    idx(t.assigned_to), t.due_at ? t.due_at.slice(0, 10) : "", Math.max(0, idx(t.created_by)),
    Math.floor(Date.parse(t.created_at) / 1000), Math.floor(Date.parse(t.updated_at) / 1000),
    t.completed_at ? Math.floor(Date.parse(t.completed_at) / 1000) : 0,
  ];
}

/** Tasks approved from the synthetic AI inbox have the deterministic id `ai<index>`, which makes approval idempotent. */
export const aiTaskId = (index: number) => `ai${index}`;
export const aiIndexOf = (taskId: string): number | null => {
  const m = /^ai(\d{1,2})$/.exec(taskId);
  return m ? Number(m[1]) : null;
};

export function fromTuple([id, title, desc, st, pr, as, due, cr, c, u, d]: StoredTask): Task {
  const ai = aiIndexOf(id);
  return {
    id, title, description: desc || null, status: TASK_STATUSES[st], priority: TASK_PRIORITIES[pr],
    assigned_to: as < 0 ? null : USER_IDS[as], assignee_name: nameAt(as), created_by: USER_IDS[cr],
    due_at: due ? `${due}T00:00:00.000Z` : null,
    source: ai === null ? "manual" : "email", external_reference: ai === null ? null : `synthetic-email:${ai}`,
    created_at: secToIso(c), updated_at: secToIso(u), completed_at: d ? secToIso(d) : null,
  };
}

/** Deterministic for a given UTC day, so every request sees identical sample data. */
export function seedTasks(nowMs: number): Task[] {
  const today = Math.floor(nowMs / DAY) * DAY;
  const at = (days: number) => new Date(today + days * DAY).toISOString();
  const rows: [string, string, TaskStatus, TaskPriority, string, number][] = [
    ["s1", "[Demo] Review sample proposal", "open", "high", "demo-member-a", 0],
    ["s2", "[Demo] Follow up on sample enquiry", "in_progress", "urgent", "demo-member-b", -2],
    ["s3", "[Demo] Update sample record", "open", "medium", "demo-admin", 1],
    ["s4", "[Demo] Prepare sample deck", "completed", "low", "demo-member-a", -3],
    ["s5", "[Demo] Schedule sample visit", "open", "low", "demo-member-b", 5],
  ];
  return rows.map(([id, title, status, priority, assigned_to, due]) => ({
    id, title, description: null, status, priority, assigned_to, assignee_name: nameAt(idx(assigned_to)),
    created_by: "demo-admin", due_at: at(due), source: "manual", external_reference: null,
    created_at: at(-4), updated_at: at(-4), completed_at: status === "completed" ? at(-3) : null,
  }));
}

export const SEED_IDS = new Set(["s1", "s2", "s3", "s4", "s5"]);

export interface View { tasks: Task[]; events: ActivityEvent[] }

/** Sample data + the visitor's stored changes. */
export function materialize(state: DemoState, nowMs: number): View {
  const seeds = seedTasks(nowMs);
  const changed = new Map(state.t.map((t) => [t[0], fromTuple(t)]));
  const created = state.t.filter((t) => !SEED_IDS.has(t[0])).map(fromTuple).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const tasks = [...created, ...seeds.map((s) => changed.get(s.id) ?? s)];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const raw: { kind: Kind; taskId: string; ts: number; actor: number; from: number; to: number }[] = [
    ...seeds.map((s) => ({ kind: "task_created" as Kind, taskId: s.id, ts: Math.floor(Date.parse(s.created_at) / 1000), actor: 0, from: -1, to: -1 })),
    ...state.e.map(([k, taskId, ts, actor, from, to]) => ({ kind: KINDS[k], taskId, ts, actor, from, to })),
  ];
  const events = raw
    .map((e, seq) => ({ e, seq, title: byId.get(e.taskId)?.title }))
    .filter((x) => x.title !== undefined)
    .sort((a, b) => b.e.ts - a.e.ts || b.seq - a.seq)
    .map(({ e, title }): ActivityEvent => ({
      id: `${e.taskId}-${e.ts}-${e.kind}`,
      event_type: e.kind,
      description: e.kind === "task_created" ? `Task created: ${title}`
        : e.kind === "task_assigned" ? `Task assigned: ${title}`
        : `Task "${title}" status: ${STATUS_LABEL[TASK_STATUSES[e.from]] ?? "?"} -> ${STATUS_LABEL[TASK_STATUSES[e.to]] ?? "?"}`,
      status: "processed", actor_id: USER_IDS[e.actor], related_task_id: e.taskId,
      related_task_title: title!, created_at: secToIso(e.ts),
    }));
  return { tasks, events };
}

export const eventTuple = (kind: Kind, taskId: string, tsSec: number, actorId: string, from = -1, to = -1): StoredEvent =>
  [KINDS.indexOf(kind), taskId, tsSec, Math.max(0, idx(actorId)), from, to];

export const statusIndex = (s: TaskStatus) => TASK_STATUSES.indexOf(s);
