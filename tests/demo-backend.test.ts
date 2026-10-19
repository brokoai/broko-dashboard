import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { company } from "../src/config/company";
import { createDemoRepo, DEMO_USERS, resetDemoStore } from "../src/lib/backend/demo/repo";
import { UserFacingError } from "../src/lib/backend/types";
import type { TaskInput } from "../src/lib/types";

const [admin, memberA, memberB] = DEMO_USERS;
const input = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: "t", description: null, status: "open", priority: "medium", assigned_to: null, due_at: null, ...over,
});

beforeEach(() => resetDemoStore());

describe("demo backend (demo mode only; not a test of any real backend)", () => {
  it("admins see all seeded tasks, members only their own", async () => {
    const all = await createDemoRepo(admin).listTasks();
    const a = await createDemoRepo(memberA).listTasks();
    assert.equal(all.length, 5);
    assert.ok(a.length > 0 && a.length < all.length);
    assert.ok(a.every((t) => t.assigned_to === memberA.id || t.created_by === memberA.id));
  });

  it("a member cannot read or update another member's task", async () => {
    const target = (await createDemoRepo(admin).listTasks()).find((t) => t.assigned_to === memberA.id)!;
    assert.equal(await createDemoRepo(memberB).getTask(target.id), null);
    await assert.rejects(createDemoRepo(memberB).updateTask(target.id, { title: "hijack" }), UserFacingError);
    assert.deepEqual(await createDemoRepo(memberB).listTaskActivity(target.id, 10), []);
  });

  it("a member cannot assign to others on create or update", async () => {
    const repo = createDemoRepo(memberA);
    await assert.rejects(repo.createTask(input({ assigned_to: memberB.id })), UserFacingError);
    const mine = await repo.createTask(input({ assigned_to: memberA.id }));
    await assert.rejects(repo.updateTask(mine.id, { assigned_to: memberB.id }), UserFacingError);
  });

  it("KPI counts match the tasks the user can see", async () => {
    for (const u of DEMO_USERS) {
      const repo = createDemoRepo(u);
      const tasks = await repo.listTasks();
      const c = await repo.taskCounts();
      assert.equal(c.completed, tasks.filter((t) => t.status === "completed").length);
      assert.equal(c.open, tasks.filter((t) => t.status === "open" || t.status === "in_progress").length);
    }
  });

  it("status updates set/clear completed_at and write activity", async () => {
    const repo = createDemoRepo(admin);
    const t = await repo.createTask(input({ assigned_to: memberA.id }));
    const done = await repo.updateTask(t.id, { status: "completed" });
    assert.ok(done.completed_at);
    const reopened = await repo.updateTask(t.id, { status: "open" });
    assert.equal(reopened.completed_at, null);
    const types = (await repo.listTaskActivity(t.id, 20)).map((e) => e.event_type);
    assert.ok(types.includes("task_created") && types.includes("task_assigned") && types.includes("task_completed"));
  });

  it("people picker exposes no contact details", async () => {
    const people = await createDemoRepo(memberA).listPeople();
    assert.ok(people.every((p) => Object.keys(p).sort().join() === "full_name,id"));
  });

  it("integrations are never reported as connected", async () => {
    const items = await createDemoRepo(admin).listIntegrations();
    assert.equal(items.length, 7);
    assert.ok(items.every((i) => i.status === "pending_setup"));
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
