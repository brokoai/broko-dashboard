import type { ZodType } from "zod";
import { scanForInjection } from "@/lib/ai-brain/injection";
import { UserFacingError } from "@/lib/backend/types";
import type { PreconRepo } from "@/lib/precon/repo";
import type { Profile } from "@/lib/types";
import { REPLACEMENT_MISMATCH, canReview, canSubmit, checkReview, sameReplacementScope } from "./policy";
import type { KnowledgeRepo } from "./repo";
import { feedbackSchema, knowledgeInputSchema, reviewSchema } from "./schemas";
import { secretSignals } from "./safety";
import { KIND_LABEL, SCOPE_LABEL, type KnowledgeInput, type KnowledgeItem } from "./types";

// Orchestration behind the knowledge server actions, free of Next.js so every rule can be tested directly. Each function
// authorizes first, validates its input, and only then touches the repository. The repository (and the database behind it)
// refuses the same things independently.

export interface KnowledgeContext {
  /** From the server session, never from the request. */
  user: Profile;
  repo: KnowledgeRepo | undefined;
  /** Used to check that a project exists and is visible to this user, and to name it in the preview. */
  precon?: PreconRepo;
  now?: () => Date;
  log?: (e: unknown) => void;
}

const NOT_CONNECTED = "Organizational knowledge is not connected to this backend.";
const SECRET_MESSAGE = "This looks like it contains a secret or a sensitive number (a password, key, token or card number). Remove it and try again. Knowledge must never contain credentials or personal financial details.";

function repoOf(ctx: KnowledgeContext): KnowledgeRepo {
  if (!ctx.repo) throw new UserFacingError(NOT_CONNECTED);
  return ctx.repo;
}

function parse<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message || "Invalid request.");
  return r.data;
}

const todayKey = (ctx: KnowledgeContext) => (ctx.now ?? (() => new Date()))().toISOString().slice(0, 10);

export interface SubmissionPreview {
  input: KnowledgeInput;
  kind_label: string;
  scope_label: string;
  project_name: string | null;
  /** The wording looks like an instruction. The reviewer is told; the text is still only ever shown as data. */
  flagged: boolean;
  /** What will happen, in plain words. */
  statement: string;
}

/** Validates everything a submission would be checked for, and returns what the reviewer will see. Writes nothing. */
async function validated(ctx: KnowledgeContext, raw: unknown): Promise<{ input: KnowledgeInput; project_name: string | null }> {
  if (!canSubmit(ctx.user)) throw new UserFacingError("Please sign in again.");
  const repo = repoOf(ctx);
  if (!repo.writable) throw new UserFacingError("The demo is read-only: knowledge cannot be submitted here.");
  const input = parse(knowledgeInputSchema, raw);
  if (secretSignals(input.title, input.body, input.source_ref, input.topic).length > 0) throw new UserFacingError(SECRET_MESSAGE);
  if (input.expires_on && input.expires_on <= todayKey(ctx)) throw new UserFacingError("The expiry date must be in the future.");
  let projectName: string | null = null;
  if (input.scope === "project") {
    // Project context is only a hint from the browser: it is checked against what THIS user may see, on every submission.
    const project = ctx.precon && input.project_id ? await ctx.precon.getProject(input.project_id) : null;
    if (!project || project.archived_at) throw new UserFacingError("That project was not found.");
    projectName = project.name;
  }
  if (input.supersedes_id) {
    const target = await repo.getItem(input.supersedes_id);
    if (!target || target.status !== "approved") throw new UserFacingError("Only an approved item can be replaced.");
    if (!sameReplacementScope(target, { scope: input.scope, project_id: input.scope === "project" ? input.project_id : null, topic: input.topic })) throw new UserFacingError(REPLACEMENT_MISMATCH);
  }
  return { input, project_name: projectName };
}

export async function previewKnowledge(ctx: KnowledgeContext, raw: unknown): Promise<SubmissionPreview> {
  const { input, project_name } = await validated(ctx, raw);
  return {
    input, project_name, kind_label: KIND_LABEL[input.kind], scope_label: SCOPE_LABEL[input.scope],
    flagged: scanForInjection(input.title, input.body).suspected,
    statement: input.supersedes_id
      ? "Nothing is saved yet. When you submit, this is sent for review as a PROPOSAL. It replaces the older item only if an administrator approves it, and until then it is not used in answers."
      : "Nothing is saved yet. When you submit, this is sent for review as a PROPOSAL. It is not used in answers until an administrator approves it.",
  };
}

export async function submitKnowledge(ctx: KnowledgeContext, raw: unknown): Promise<KnowledgeItem> {
  const { input } = await validated(ctx, raw);
  return repoOf(ctx).submit(input);
}

export async function reviewKnowledge(ctx: KnowledgeContext, raw: unknown): Promise<KnowledgeItem> {
  const repo = repoOf(ctx);
  if (!repo.writable) throw new UserFacingError("The demo is read-only: knowledge cannot be reviewed here.");
  if (!canReview(ctx.user)) throw new UserFacingError("You do not have permission to do that.");
  const { id, action, note } = parse(reviewSchema, raw);
  if (note && secretSignals(note).length > 0) throw new UserFacingError(SECRET_MESSAGE);
  const item = await repo.getItem(id);
  if (!item) throw new UserFacingError("That item was not found.");
  const problem = checkReview(item, action, note, (ctx.now ?? (() => new Date()))());
  if (problem) throw new UserFacingError(problem);
  if (action === "approve" && item.supersedes_id) {
    // Refuse before anything changes: a replacement may only retire an item of the same scope, project and topic (the database checks it too).
    const target = await repo.getItem(item.supersedes_id);
    if (target?.status === "approved" && !sameReplacementScope(item, target)) throw new UserFacingError(REPLACEMENT_MISMATCH);
  }
  return repo.review(id, action, note);
}

/** Feedback is metadata only (a rating, a fixed reason, the intent and source ids). It is best effort and never touches knowledge. */
export async function sendFeedback(ctx: KnowledgeContext, raw: unknown): Promise<void> {
  const repo = repoOf(ctx);
  if (!repo.writable) throw new UserFacingError("The demo does not save feedback.");
  await repo.recordFeedback(parse(feedbackSchema, raw));
}
