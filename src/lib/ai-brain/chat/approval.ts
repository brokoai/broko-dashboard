import { canAssignTo, checkTaskChange } from "@/lib/permissions";
import type { Profile } from "@/lib/types";
import type { ActionKind, ApprovalRequest } from "./types";

/**
 * Turns a requested change into a structured, NON-executed approval request. Chat holds no write path.
 * `permitted` applies the EXISTING permission policy (permissions.ts, admin-only AI Inbox review) to this user so the answer
 * is honest about who can do it; the actual change still happens on the normal screen, under the normal checks and audit trail.
 */
export function buildApproval(user: Profile, action: ActionKind): ApprovalRequest {
  const base = { required: true, executed: false, action } as const;
  const admin = user.role === "admin";
  switch (action) {
    case "create_task":
      return { ...base, label: "Create a task", permitted: canAssignTo(user, user.id), reason: "Anyone can create a task for themselves; the task form applies the normal checks.", where: { label: "Open Tasks", href: "/tasks" } };
    case "assign_task": {
      const denied = checkTaskChange(user, null, { assigned_to: "__another_user__" });
      return { ...base, label: "Assign a task", permitted: denied === null, reason: denied ?? "Administrators can assign tasks to anyone, from the task page.", where: { label: "Open Tasks", href: "/tasks" } };
    }
    case "update_task":
      return { ...base, label: "Change a task", permitted: null, reason: "You can change tasks assigned to or created by you; administrators can change any task. The task page checks this for the specific task.", where: { label: "Open Tasks", href: "/tasks" } };
    case "delete_record":
      return { ...base, label: "Delete a record", permitted: null, reason: "Chat cannot delete anything. Any change to a record is made on its own page, under the normal checks.", where: { label: "Open Tasks", href: "/tasks" } };
    case "send_message":
      return { ...base, label: "Send a message", permitted: null, reason: "Chat never sends messages, and no email, Teams or WhatsApp account is connected for it to use.", where: { label: "See integrations", href: "/integrations" } };
    case "schedule_event":
      return { ...base, label: "Schedule an event", permitted: null, reason: "No calendar is connected for the assistant, and chat cannot create events.", where: { label: "See integrations", href: "/integrations" } };
    case "review_ai_message":
      return { ...base, label: "Approve or reject an AI Inbox message", permitted: admin, reason: admin ? "Administrators review AI Inbox messages; approval creates the task and is recorded." : "Only administrators can review AI Inbox messages.", where: admin ? { label: "Open the AI Inbox review queue", href: "/inbox" } : { label: "Open Tasks", href: "/tasks" } };
    case "change_configuration":
      return { ...base, label: "Change configuration", permitted: admin, reason: admin ? "Configuration is changed on the Integrations or Settings pages." : "Only administrators can change configuration.", where: { label: "Open Integrations", href: "/integrations" } };
  }
}
