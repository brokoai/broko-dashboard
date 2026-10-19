import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { company } from "../src/config/company";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { LIMITS } from "../src/lib/backend/demo/state";
import { UserFacingError } from "../src/lib/backend/types";
import type { TaskInput } from "../src/lib/types";

const [admin, memberA, memberB] = DEMO_USERS;
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const input = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: "t", description: null, status: "open", priority: "medium", assigned_to: null, due_at: null, ...over,
});
/** One visitor = one store (their browser cookie). */
const visitor = () => memoryStore();
const as = (u: typeof admin, store = visitor()) => createDemoRepo(u, store, () => NOW);

describe("demo backend (demo mode only; not a test of any real backend)", () => {
  it("admins see all sample tasks, members only their own", async () => {
    const all = await as(admin).listTasks();
    const a = await as(memberA).listTasks();
    assert.equal(all.length, 5);
    assert.ok(a.length > 0 && a.length < all.length);
    assert.ok(a.every((t) => t.assigned_to === memberA.id || t.created_by === memberA.id));
  });

  it("a member cannot read or update another member's task", async () => {
    const store = visitor();
    const target = (await as(admin, store).listTasks()).find((t) => t.assigned_to === memberA.id)!;
    assert.equal(await as(memberB, store).getTask(target.id), null);
    await assert.rejects(as(memberB, store).updateTask(target.id, { title: "hijack" }), UserFacingError);
    assert.deepEqual(await as(memberB, store).listTaskActivity(target.id, 10), []);
  });

  it("a member cannot assign to others on create or update", async () => {
    const store = visitor();
    const repo = as(memberA, store);
    await assert.rejects(repo.createTask(input({ assigned_to: memberB.id })), UserFacingError);
    const mine = await repo.createTask(input({ assigned_to: memberA.id }));
    await assert.rejects(repo.updateTask(mine.id, { assigned_to: memberB.id }), UserFacingError);
  });

  it("KPI counts match the tasks the user can see", async () => {
    for (const u of DEMO_USERS) {
      const repo = as(u);
      const tasks = await repo.listTasks();
      const c = await repo.taskCounts();
      assert.equal(c.completed, tasks.filter((t) => t.status === "completed").length);
      assert.equal(c.open, tasks.filter((t) => t.status === "open" || t.status === "in_progress").length);
    }
  });

  it("status updates set/clear completed_at and write activity", async () => {
    const repo = as(admin);
    const t = await repo.createTask(input({ assigned_to: memberA.id }));
    const done = await repo.updateTask(t.id, { status: "completed" });
    assert.ok(done.completed_at);
    assert.equal((await repo.updateTask(t.id, { status: "open" })).completed_at, null);
    const types = (await repo.listTaskActivity(t.id, 20)).map((e) => e.event_type);
    assert.ok(types.includes("task_created") && types.includes("task_assigned") && types.includes("task_completed"));
  });

  it("people picker exposes no contact details", async () => {
    const people = await as(memberA).listPeople();
    assert.ok(people.every((p) => Object.keys(p).sort().join() === "full_name,id"));
  });

  it("integrations are never reported as connected", async () => {
    const items = await as(admin).listIntegrations();
    assert.equal(items.length, 7);
    assert.ok(items.every((i) => i.status === "pending_setup"));
  });
});

describe("per-visitor demo state", () => {
  it("changes persist for the same visitor across requests", async () => {
    const store = visitor();
    const t = await as(admin, store).createTask(input({ title: "[Mine] persisted", assigned_to: memberA.id }));
    const again = await as(admin, store).getTask(t.id); // new repo instance, same cookie
    assert.equal(again?.title, "[Mine] persisted");
    assert.equal((await as(admin, store).taskCounts()).open, 5);
  });

  it("is isolated between visitors", async () => {
    const v1 = visitor(), v2 = visitor();
    await as(admin, v1).createTask(input({ title: "[Visitor1] only" }));
    assert.equal((await as(admin, v1).listTasks()).length, 6);
    assert.equal((await as(admin, v2).listTasks()).length, 5);
  });

  it("editing a sample task is stored as a change on top of the sample data", async () => {
    const store = visitor();
    const repo = as(admin, store);
    const s1 = (await repo.listTasks()).find((t) => t.id === "s1")!;
    await repo.updateTask("s1", { status: "completed" });
    assert.equal((await as(admin, store).getTask("s1"))?.status, "completed");
    assert.equal((await as(admin, visitor()).getTask("s1"))?.status, s1.status); // other visitor unaffected
  });

  it("is bounded: refuses more than the task limit with a clear message", async () => {
    const repo = as(admin);
    for (let i = 0; i < LIMITS.tasks; i++) await repo.createTask(input({ title: `n${i}` }));
    await assert.rejects(repo.createTask(input({ title: "one too many" })), /Reset demo/);
  });

  it("rejects over-long text in the demo", async () => {
    await assert.rejects(as(admin).createTask(input({ title: "x".repeat(LIMITS.title + 1) })), UserFacingError);
  });

  it("derives assignment notifications for the assignee only", async () => {
    const store = visitor();
    await as(admin, store).createTask(input({ title: "[N] for A", assigned_to: memberA.id }));
    assert.equal((await as(memberA, store).listNotifications()).length, 1);
    assert.equal((await as(memberB, store).listNotifications()).length, 0);
  });
});

describe("company identity", () => {
  it("Pankaj Arora is Founder & CEO", () => {
    assert.deepEqual(company.leadership.filter((l) => l.name === "Pankaj Arora").map((l) => l.title), ["Founder & CEO"]);
  });
  it("nobody else is Founder/CEO and no demo account is", () => {
    assert.ok(company.leadership.every((l) => l.name === "Pankaj Arora" || !/founder|ceo/i.test(l.title)));
    assert.ok(DEMO_USERS.every((u) => !/founder|ceo|abhishek/i.test(`${u.full_name} ${u.title ?? ""}`)));
  });
});
