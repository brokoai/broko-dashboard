export type Role = "admin" | "member";
export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type IntegrationStatus = "connected" | "disconnected" | "pending_setup" | "error";
export type IntegrationProvider =
  | "microsoft_outlook" | "microsoft_teams" | "microsoft_calendar" | "onedrive"
  | "gmail" | "google_calendar" | "whatsapp_business";
export type EventType =
  | "email_received" | "message_classified" | "potential_task_identified"
  | "task_created" | "task_assigned" | "task_updated" | "task_completed"
  | "notification_sent" | "workflow_failed";
export type EventStatus = "processed" | "pending" | "failed";

export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  role: Role;
  title: string | null;
}

/** Minimal identity for pickers. Deliberately has no email or other contact details. */
export type Person = Pick<Profile, "id" | "full_name">;

export interface TaskCounts {
  open: number;
  due_today: number;
  overdue: number;
  completed: number;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  assignee_name: string | null;
  created_by: string | null;
  due_at: string | null;
  source: string;
  external_reference: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskInput {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  due_at: string | null;
}

export interface ActivityEvent {
  id: string;
  event_type: EventType;
  description: string;
  status: EventStatus;
  actor_id: string | null;
  related_task_id: string | null;
  related_task_title: string | null;
  created_at: string;
}

export interface Integration {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  last_sync_at: string | null;
  last_error: string | null;
}

export interface TeamMember {
  member_id: string;
  full_name: string;
  title: string | null;
  role: Role;
  assigned_count: number;
  open_count: number;
  completed_count: number;
}

export interface AppNotification {
  id: string;
  title: string;
  created_at: string;
  read_at: string | null;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open", in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled",
};
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low", medium: "Medium", high: "High", urgent: "Urgent",
};
export const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
export const TASK_STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];
export const TASK_PRIORITIES = Object.keys(PRIORITY_LABEL) as TaskPriority[];
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", member: "Team Member" };

export const INTEGRATION_META: Record<IntegrationProvider, string> = {
  microsoft_outlook: "Microsoft Outlook",
  microsoft_teams: "Microsoft Teams",
  microsoft_calendar: "Microsoft Calendar",
  onedrive: "OneDrive",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  whatsapp_business: "WhatsApp Business",
};
export const INTEGRATION_ORDER = Object.keys(INTEGRATION_META) as IntegrationProvider[];
