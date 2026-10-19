import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canAssignTo, canEditTask, checkTaskChange } from "../src/lib/permissions";
import type { Profile } from "../src/lib/types";

const admin: Profile = { id: "a", full_name: "Admin", email: null, role: "admin", title: null };
const memberA: Profile = { id: "m1", full_name: "A", email: null, role: "member", title: null };
const memberB: Profile = { id: "m2", full_name: "B", email: null, role: "member", title: null };

describe("permissions", () => {
  it("admins may assign to anyone; members only to self or nobody", () => {
    assert.equal(canAssignTo(admin, "m2"), true);
    assert.equal(canAssignTo(memberA, "m1"), true);
    assert.equal(canAssignTo(memberA, null), true);
    assert.equal(canAssignTo(memberA, "m2"), false);
  });

  it("members can edit only tasks assigned to or created by them", () => {
    assert.equal(canEditTask(memberA, { assigned_to: "m1", created_by: "a" }), true);
    assert.equal(canEditTask(memberA, { assigned_to: "x", created_by: "m1" }), true);
    assert.equal(canEditTask(memberA, { assigned_to: "m2", created_by: "a" }), false);
    assert.equal(canEditTask(admin, { assigned_to: "m2", created_by: "m2" }), true);
  });

  it("member cannot reassign an editable task to someone else (regression)", () => {
    const current = { assigned_to: "m1", created_by: "m1" };
    assert.match(checkTaskChange(memberA, current, { assigned_to: "m2" }) ?? "", /Only administrators/);
  });

  it("an unchanged assignee in an edit form is allowed", () => {
    const current = { assigned_to: "m2", created_by: "m1" }; // created by A, assigned to B
    assert.equal(checkTaskChange(memberA, current, { assigned_to: "m2", title: "x" }), null);
  });

  it("member cannot touch a task they cannot see", () => {
    assert.equal(checkTaskChange(memberB, { assigned_to: "m1", created_by: "a" }, { title: "x" }), "Task not found.");
  });

  it("create: member may not assign to others", () => {
    assert.notEqual(checkTaskChange(memberA, null, { assigned_to: "m2" }), null);
    assert.equal(checkTaskChange(memberA, null, { assigned_to: "m1" }), null);
    assert.equal(checkTaskChange(admin, null, { assigned_to: "m2" }), null);
  });
});
