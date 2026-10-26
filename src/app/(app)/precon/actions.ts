"use server";

import { revalidatePath } from "next/cache";
import { UserFacingError } from "@/lib/backend/types";
import type { ImportPreview } from "@/lib/precon/inventory-import";
import {
  archiveProject, beginUpload, commitInventoryImport, createProject, finishUpload, previewInventoryImport, reprocessDocument, removeDocument,
  updateProject, verifyInventory, type ImportOutcome,
} from "@/lib/precon/service";
import { preconContext } from "./_lib";

// Thin wrappers: authenticate first (the session decides who the user is), run the tested service, and turn failures into
// messages. UserFacingError text is shown; anything else is logged on the server and replaced by a generic sentence.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown, fallback: string): { ok: false; error: string } {
  if (e instanceof UserFacingError) return { ok: false, error: e.message };
  console.error("[precon]", e);
  return { ok: false, error: fallback };
}

const refresh = () => revalidatePath("/precon", "layout");

export interface ProjectFormState { ok?: boolean; error?: string; id?: string }

export async function saveProject(_prev: ProjectFormState, form: FormData): Promise<ProjectFormState> {
  const ctx = await preconContext();
  const id = String(form.get("id") ?? "");
  const input = {
    name: String(form.get("name") ?? ""), developer: String(form.get("developer") ?? ""), city: String(form.get("city") ?? ""),
    address: String(form.get("address") ?? ""), status: String(form.get("status") ?? ""), description: String(form.get("description") ?? ""),
    expected_completion: String(form.get("expected_completion") ?? ""),
  };
  try {
    const project = id ? await updateProject(ctx, id, input) : await createProject(ctx, input);
    refresh();
    return { ok: true, id: project.id };
  } catch (e) {
    const r = fail(e, "The project could not be saved. Please try again.");
    return { error: r.error };
  }
}

export async function setProjectArchived(projectId: string, archived: boolean): Promise<ActionResult> {
  const ctx = await preconContext();
  try {
    await archiveProject(ctx, projectId, archived);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "The project could not be updated.");
  }
}

export async function beginUploadAction(input: unknown): Promise<ActionResult<{ documentId: string; uploadUrl: string }>> {
  const ctx = await preconContext();
  try {
    return { ok: true, ...(await beginUpload(ctx, input)) };
  } catch (e) {
    return fail(e, "The upload could not be started.");
  }
}

export async function finishUploadAction(input: unknown): Promise<ActionResult<{ documentId: string; status: string; detail: string | null }>> {
  const ctx = await preconContext();
  try {
    const r = await finishUpload(ctx, input);
    refresh();
    return r.ok ? { ok: true, documentId: r.document.id, status: r.document.status, detail: r.document.status_detail } : { ok: false, error: r.error };
  } catch (e) {
    return fail(e, "The file was uploaded but could not be processed. You can retry from the document page.");
  }
}

export async function reprocessAction(documentId: string): Promise<ActionResult<{ status: string }>> {
  const ctx = await preconContext();
  try {
    const d = await reprocessDocument(ctx, documentId);
    refresh();
    return { ok: true, status: d.status };
  } catch (e) {
    return fail(e, "The document could not be reprocessed.");
  }
}

export async function removeDocumentAction(documentId: string): Promise<ActionResult> {
  const ctx = await preconContext();
  try {
    await removeDocument(ctx, documentId);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "The document could not be removed.");
  }
}

export async function previewImportAction(documentId: string, mapping?: Record<string, number>): Promise<ActionResult<{ preview: ImportPreview; filename: string }>> {
  const ctx = await preconContext();
  try {
    const r = await previewInventoryImport(ctx, documentId, mapping);
    return { ok: true, preview: r.preview, filename: r.document.filename };
  } catch (e) {
    return fail(e, "The spreadsheet could not be read.");
  }
}

export async function commitImportAction(input: unknown): Promise<ActionResult<{ outcome: ImportOutcome }>> {
  const ctx = await preconContext();
  try {
    const outcome = await commitInventoryImport(ctx, input);
    refresh();
    return { ok: true, outcome };
  } catch (e) {
    return fail(e, "The import could not be completed.");
  }
}

export async function verifyInventoryAction(unitId: string, verified: boolean): Promise<ActionResult> {
  const ctx = await preconContext();
  try {
    await verifyInventory(ctx, unitId, verified);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e, "The record could not be updated.");
  }
}
