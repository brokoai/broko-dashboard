import { z } from "zod";
import { CHAT_INTENTS, SOURCE_IDS } from "@/lib/ai-brain/chat/types";
import { UUID_RE } from "@/lib/precon/files";
import { cleanLine, cleanText } from "./safety";
import {
  FEEDBACK_RATINGS, FEEDBACK_REASONS, KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES, LIMITS,
  type FeedbackInput, type KnowledgeInput, type ReviewAction,
} from "./types";

// Every server action parses its input with these. Browser-side checks are only a convenience, and nothing the browser sends
// (ids, roles, status, author, reviewer, timestamps) is trusted: the strict schemas reject unknown keys outright.

export const uuid = z.string().regex(UUID_RE, "Invalid id.");
const line = (max: number) => z.string().max(max * 2).transform(cleanLine);
const block = (max: number) => z.string().max(max * 2).transform(cleanText);
const emptyToNull = <T>(v: T | "" | null | undefined): T | null => (v === "" || v === undefined ? null : v);

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100;
}, "Enter a valid date.");

const topic = z.string().max(LIMITS.topic * 2).transform((s) => cleanLine(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
  .refine((s) => s.length <= LIMITS.topic, `Keep the topic under ${LIMITS.topic} characters.`);

export const knowledgeInputSchema = z.strictObject({
  kind: z.enum(KNOWLEDGE_KINDS, "Choose what kind of knowledge this is."),
  scope: z.enum(KNOWLEDGE_SCOPES, "Choose who this applies to."),
  project_id: z.union([uuid, z.literal("")]).nullable().optional().transform((v) => emptyToNull(v)),
  title: line(LIMITS.title.max).refine((s) => s.length >= LIMITS.title.min, `Give it a title of at least ${LIMITS.title.min} characters.`)
    .refine((s) => s.length <= LIMITS.title.max, `Keep the title under ${LIMITS.title.max} characters.`),
  body: block(LIMITS.body.max).refine((s) => s.length >= LIMITS.body.min, `Describe it in at least ${LIMITS.body.min} characters.`)
    .refine((s) => s.length <= LIMITS.body.max, `Keep the text under ${LIMITS.body.max} characters.`),
  topic: z.union([topic, z.literal("")]).nullable().optional().transform((v) => emptyToNull(v)),
  source_ref: z.union([line(LIMITS.sourceRef), z.literal("")]).nullable().optional().transform((v) => emptyToNull(v))
    .refine((s) => s === null || s.length <= LIMITS.sourceRef, `Keep the source under ${LIMITS.sourceRef} characters.`),
  supersedes_id: z.union([uuid, z.literal("")]).nullable().optional().transform((v) => emptyToNull(v)),
  expires_on: z.union([isoDay, z.literal("")]).nullable().optional().transform((v) => emptyToNull(v)),
}).superRefine((v, ctx) => {
  if (v.scope === "project" && !v.project_id) ctx.addIssue({ code: "custom", path: ["project_id"], message: "Choose the project this applies to." });
  if (v.scope === "organization" && v.project_id) ctx.addIssue({ code: "custom", path: ["project_id"], message: "Organization-wide knowledge cannot belong to a project." });
  if (v.kind === "project_note" && v.scope !== "project") ctx.addIssue({ code: "custom", path: ["scope"], message: "A project note must belong to a project." });
}) satisfies z.ZodType<KnowledgeInput, unknown>;

export const reviewSchema = z.strictObject({
  id: uuid,
  action: z.enum(["approve", "reject", "expire"] as [ReviewAction, ...ReviewAction[]]),
  note: z.union([line(LIMITS.note), z.literal("")]).nullable().optional().transform((v) => emptyToNull(v))
    .refine((s) => s === null || s.length <= LIMITS.note, `Keep the note under ${LIMITS.note} characters.`),
});

export const feedbackSchema = z.strictObject({
  rating: z.enum(FEEDBACK_RATINGS),
  reason: z.enum(FEEDBACK_REASONS).nullable().optional().transform((v) => v ?? null),
  intent: z.enum(CHAT_INTENTS).nullable().optional().transform((v) => v ?? null),
  // Unknown ids are dropped, not stored: this is a fixed vocabulary.
  source_ids: z.array(z.string()).max(40).optional().transform((v) => [...new Set((v ?? []).filter((s): s is (typeof SOURCE_IDS)[number] => (SOURCE_IDS as readonly string[]).includes(s)))].slice(0, SOURCE_IDS.length)),
}) satisfies z.ZodType<FeedbackInput, unknown>;
