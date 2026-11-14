import { DEMO_PROJECT_IDS } from "@/lib/precon/demo-data";
import { emptyKnowledgeStore, type KnowledgeStore } from "./memory-repo";
import type { KnowledgeItem } from "./types";

// SYNTHETIC SAMPLE KNOWLEDGE for the public demo. Every title starts with "[Demo]" and nothing here is a real decision, procedure
// or fact about a real organization. The demo is read-only: a visitor cannot submit, review or save anything, so this store is
// rebuilt for each request and nothing persists. Dates are relative to "now" so the demo never looks abandoned.

const id = (n: number) => `d4400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (now: Date, offsetDays: number) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString();

export function demoKnowledgeStore(now: Date = new Date()): KnowledgeStore {
  const store = emptyKnowledgeStore();
  const base = {
    author_id: null, author_name: "[Demo] Sample author", source_type: "manual" as const, supersedes_id: null,
    reviewed_by: null, reviewer_name: "[Demo] Sample administrator", expires_at: null as string | null, review_note: null as string | null,
  };
  const items: KnowledgeItem[] = [
    {
      ...base, id: id(1), kind: "procedure", scope: "organization", project_id: null, status: "approved", topic: "client-follow-up",
      title: "[Demo] Follow up with new enquiries within one business day",
      body: "SAMPLE DATA. Every new enquiry gets a first reply within one business day. If the enquiry is about a specific project, link the relevant brochure and offer a call. Record the outcome on the task.",
      source_ref: "[Demo] Sample operations handbook", effective_from: day(now, -60), created_at: day(now, -60), updated_at: day(now, -45), reviewed_at: day(now, -45),
    },
    {
      ...base, id: id(2), kind: "decision", scope: "organization", project_id: null, status: "approved", topic: "weekly-review",
      title: "[Demo] Weekly pipeline review moved to Thursdays",
      body: "SAMPLE DATA. The weekly pipeline review is held on Thursdays at 10:00. Overdue follow-ups are reviewed first, then new enquiries.",
      source_ref: "[Demo] Sample team meeting", effective_from: day(now, -20), created_at: day(now, -20), updated_at: day(now, -18), reviewed_at: day(now, -18),
    },
    {
      ...base, id: id(3), kind: "project_note", scope: "project", project_id: DEMO_PROJECT_IDS.harbour, status: "approved", topic: "parking",
      title: "[Demo] Harbourfront Residences: parking is sold separately",
      body: "SAMPLE DATA. Underground parking at this sample project is not included in the unit price and is offered separately, subject to availability. Confirm the current parking price with the developer before quoting it.",
      source_ref: "[Demo] Sample developer call", effective_from: day(now, -10), created_at: day(now, -10), updated_at: day(now, -9), reviewed_at: day(now, -9),
    },
    {
      ...base, id: id(4), kind: "procedure", scope: "organization", project_id: null, status: "approved", topic: "document-naming",
      title: "[Demo] Name uploaded documents with the project and the date",
      body: "SAMPLE DATA. Name brochures and price lists with the project name and the month, for example harbourfront-price-list-2026-10, so the newest version is easy to find. This sample item has not been reviewed for a long time.",
      source_ref: null, effective_from: day(now, -400), created_at: day(now, -400), updated_at: day(now, -380), reviewed_at: day(now, -380),
    },
    {
      ...base, id: id(5), kind: "decision", scope: "organization", project_id: null, status: "approved", topic: "reservation-deposit",
      title: "[Demo] Reservation deposit is 5 percent",
      body: "SAMPLE DATA. Reservations are taken with a 5 percent deposit.",
      source_ref: "[Demo] Sample sales memo", effective_from: day(now, -30), created_at: day(now, -30), updated_at: day(now, -29), reviewed_at: day(now, -29),
    },
    {
      ...base, id: id(6), kind: "correction", scope: "organization", project_id: null, status: "approved", topic: "reservation-deposit", source_type: "correction",
      title: "[Demo] Reservation deposit is 10 percent",
      body: "SAMPLE DATA. Reservations are taken with a 10 percent deposit. This sample item deliberately conflicts with the 5 percent one, to show how conflicting approved knowledge is reported rather than silently resolved.",
      source_ref: "[Demo] Sample sales memo, revised", effective_from: day(now, -5), created_at: day(now, -5), updated_at: day(now, -4), reviewed_at: day(now, -4),
    },
    {
      ...base, id: id(7), kind: "decision", scope: "organization", project_id: null, status: "proposed", topic: "office-hours",
      title: "[Demo] Office hours extended on Fridays", body: "SAMPLE DATA. A proposal that has NOT been approved: it is never used in answers.", source_ref: null,
      reviewed_by: null, reviewer_name: null, effective_from: day(now, -1), created_at: day(now, -1), updated_at: day(now, -1), reviewed_at: null,
    },
  ];
  store.items.push(...items);
  return store;
}
