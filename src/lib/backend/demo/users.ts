import type { Profile } from "@/lib/types";

/** Placeholder accounts. Not real Broko employees. */
export const DEMO_USERS: Profile[] = [
  { id: "demo-admin", full_name: "Demo Administrator", email: null, role: "admin", title: "Application Administrator" },
  { id: "demo-member-a", full_name: "Demo Member A", email: null, role: "member", title: null },
  { id: "demo-member-b", full_name: "Demo Member B", email: null, role: "member", title: null },
];
