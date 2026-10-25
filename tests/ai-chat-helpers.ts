import type { BrainChatContext, ChatReply } from "../src/lib/ai-brain/chat";
import type { Repo } from "../src/lib/backend/types";
import type { ActivityEvent, AppNotification, Integration, Profile, Task } from "../src/lib/types";

export const NOW = new Date("2026-10-25T12:00:00Z");
export const admin: Profile = { id: "u-admin", full_name: "Ada Admin", email: "ada@example.test", role: "admin", title: null };
export const alice: Profile = { id: "u-alice", full_name: "Alice", email: null, role: "member", title: null };
export const bob: Profile = { id: "u-bob", full_name: "Bob", email: null, role: "member", title: null };

let n = 0;
export const task = (over: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `Task ${n}`, description: null, status: "open", priority: "medium", assigned_to: null, assignee_name: null,
  created_by: null, due_at: null, source: "manual", external_reference: null,
  created_at: "2026-10-20T09:00:00Z", updated_at: "2026-10-20T09:00:00Z", completed_at: null, ...over,
});
export const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++n}`, event_type: "task_created", description: `Event ${n}`, status: "processed", actor_id: null,
  related_task_id: null, related_task_title: null, created_at: "2026-10-25T08:00:00Z", ...over,
});
export const notification = (over: Partial<AppNotification> = {}): AppNotification => ({ id: `n${++n}`, title: `Note ${n}`, created_at: NOW.toISOString(), read_at: null, ...over });

export interface Spy { reads: string[]; writes: string[] }
export const READ_METHODS = ["listTasks", "getTask", "listActivity", "listTaskActivity", "listIntegrations", "listNotifications", "listPeople", "teamWorkload", "taskCounts"];

/** A fake repository that records every call. Writes are recorded AND refused, so a test fails loudly if chat ever tries one. */
export function fakeRepo(data: {
  tasks?: Task[]; activity?: ActivityEvent[]; notifications?: AppNotification[]; integrations?: Integration[];
  throwOn?: string[]; aiInbox?: Repo["aiInbox"]; aiInboxCounts?: Repo["aiInboxCounts"]; aiInboxWriter?: Repo["aiInboxWriter"];
} = {}): { repo: Repo; spy: Spy } {
  const spy: Spy = { reads: [], writes: [] };
  const read = <T>(name: string, v: T) => async () => {
    spy.reads.push(name);
    if (data.throwOn?.includes(name)) throw new Error("SECRET-CONNECTION-STRING postgres://user:pw@host");
    return v;
  };
  const write = (name: string) => async () => { spy.writes.push(name); throw new Error("write attempted"); };
  const repo = {
    listTasks: read("listTasks", data.tasks ?? []),
    getTask: read("getTask", null),
    listActivity: read("listActivity", data.activity ?? []),
    listTaskActivity: read("listTaskActivity", []),
    listIntegrations: read("listIntegrations", data.integrations ?? []),
    listNotifications: read("listNotifications", data.notifications ?? []),
    listPeople: read("listPeople", []),
    teamWorkload: read("teamWorkload", []),
    taskCounts: read("taskCounts", { open: 0, due_today: 0, overdue: 0, completed: 0 }),
    createTask: write("createTask"), updateTask: write("updateTask"),
    ...(data.aiInbox ? { aiInbox: data.aiInbox } : {}),
    ...(data.aiInboxCounts ? { aiInboxCounts: data.aiInboxCounts } : {}),
    ...(data.aiInboxWriter ? { aiInboxWriter: data.aiInboxWriter } : {}),
  } as unknown as Repo;
  return { repo, spy };
}

export const ctx = (user: Profile, repo: Repo, mode: "demo" | "live" = "live"): BrainChatContext => ({ user, repo, mode, now: NOW });
export const everything = (r: ChatReply) => JSON.stringify(r);
export const items = (r: ChatReply) => r.sections.flatMap((s) => s.items ?? []).map((i) => i.text);
