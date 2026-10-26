import { z } from "zod";
import { DOC_KINDS, PROJECT_STATUSES, type DocKind, type ProjectInput, type ProjectStatus } from "./types";
import { UUID_RE } from "./files";

// Every server action parses its input with these. Browser-side checks are only a convenience.

const text = (max: number) =>
  z.string().max(max).transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim());
const optionalText = (max: number) => text(max).transform((s) => (s === "" ? null : s)).nullable().optional().transform((v) => v ?? null);

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100;
}, "Enter a valid date.");

export const projectInputSchema = z.strictObject({
  name: text(200).refine((s) => s.length >= 1, "Enter a project name."),
  developer: optionalText(200),
  city: optionalText(100),
  address: optionalText(300),
  status: z.enum(PROJECT_STATUSES as [ProjectStatus, ...ProjectStatus[]]),
  description: optionalText(4000),
  expected_completion: z.union([isoDay, z.literal("")]).nullable().optional().transform((v) => (v ? v : null)),
});

export const projectPatchSchema = projectInputSchema.partial();

export const uuid = z.string().regex(UUID_RE, "Invalid id.");

export const beginUploadSchema = z.strictObject({
  projectId: uuid,
  filename: z.string().min(1).max(400),
  mime: z.string().max(120),
  size: z.number().int().positive(),
  kind: z.enum(DOC_KINDS as [DocKind, ...DocKind[]]),
  title: optionalText(200),
});

export const finishUploadSchema = z.strictObject({ documentId: uuid, replaces: uuid.optional() });

export const mappingSchema = z.record(z.string(), z.number().int().min(0).max(99)).optional();

export const importCommitSchema = z.strictObject({
  documentId: uuid,
  mapping: mappingSchema,
  mode: z.enum(["insert_only", "update_conflicts"]),
  /** The user confirmed that rows with errors are skipped. */
  skipErrors: z.boolean(),
});

export type ParsedProjectInput = ProjectInput;
