import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserFacingError } from "../src/lib/backend/types";
import {
  archiveProject, beginUpload, commitInventoryImport, createProject, documentLink, finishUpload, previewInventoryImport, reprocessDocument,
  removeDocument, updateProject, verifyInventory, type PreconContext,
} from "../src/lib/precon/service";
import { MAX_UPLOAD_BYTES } from "../src/lib/precon/files";
import { JPG_BYTES, makePdf, makeXlsx, utf8 } from "./precon-fixtures";
import { ADMIN, MEMBER, world } from "./precon-helpers";

const PROJECT = { name: "Lakeview Towers", developer: "Acme Developments", city: "Toronto", address: "1 Lake Shore Blvd", status: "selling", description: "A waterfront tower.", expected_completion: "2028-06-30" };
const denied = (e: unknown) => e instanceof UserFacingError;

async function upload(ctx: PreconContext, w: ReturnType<typeof world>, projectId: string, filename: string, bytes: Uint8Array, over: Record<string, unknown> = {}) {
  const mime = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".png") ? "image/png" : filename.endsWith(".jpg") ? "image/jpeg" : filename.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv";
  const t = await beginUpload(ctx, { projectId, filename, mime, size: bytes.byteLength, kind: filename.endsWith(".pdf") ? "brochure" : "inventory_sheet", ...over });
  w.files.put(t.uploadUrl, bytes);
  return { ticket: t, result: await finishUpload(ctx, { documentId: t.documentId }) };
}

describe("projects", () => {
  it("an administrator creates, edits and archives a project; each step is audited without content", async () => {
    const w = world();
    const p = await createProject(w.ctx(ADMIN), PROJECT);
    assert.equal(p.name, "Lakeview Towers");
    const u = await updateProject(w.ctx(ADMIN), p.id, { status: "completed" });
    assert.equal(u.status, "completed");
    const a = await archiveProject(w.ctx(ADMIN), p.id, true);
    assert.ok(a.archived_at);
    assert.deepEqual(w.store.audit.map((x) => x.action), ["project.create", "project.update", "project.archive"]);
    assert.ok(!JSON.stringify(w.store.audit).includes("waterfront"), "audit must not hold content");
  });
  it("validates input on the server (blank name, bad status, bad date, unknown field)", async () => {
    const w = world();
    for (const bad of [{ ...PROJECT, name: "   " }, { ...PROJECT, status: "bogus" }, { ...PROJECT, expected_completion: "2028-02-31" }, { ...PROJECT, extra: 1 }, { ...PROJECT, name: "x".repeat(201) }]) {
      await assert.rejects(createProject(w.ctx(ADMIN), bad), denied);
    }
  });
  it("members and the read-only demo cannot write", async () => {
    const w = world();
    await assert.rejects(createProject(w.ctx(MEMBER), PROJECT), (e) => denied(e) && /permission/.test((e as Error).message));
    const demoCtx = w.ctx(ADMIN, { repo: w.repoFor(ADMIN, false) });
    await assert.rejects(createProject(demoCtx, PROJECT), (e) => denied(e) && /read-only/.test((e as Error).message));
    assert.equal(w.store.projects.length, 0);
  });
  it("fails clearly when the backend has no Pre-Construction repository", async () => {
    await assert.rejects(createProject(world().ctx(ADMIN, { repo: undefined }), PROJECT), (e) => denied(e) && /not connected/.test((e as Error).message));
  });
});

describe("upload, ingest and search (real bytes, real extraction)", () => {
  it("a valid PDF is uploaded, processed, chunked with pages, and then findable", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket, result } = await upload(ctx, w, p.id, "Lakeview Brochure.pdf", makePdf(["Welcome to Lakeview Towers", "Two bedroom suites feature lake views and a rooftop pool"]));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.document.status, "processed");
    assert.equal(result.document.page_count, 2);
    assert.equal(result.document.chunk_count, 2);
    assert.equal(result.document.id, ticket.documentId);
    const hits = await w.repoFor(MEMBER).searchChunks("rooftop pool");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].page, 2);
    assert.equal(hits[0].document_id, ticket.documentId);
  });
  it("the browser never receives a storage path, and the object lands under the project and document ids", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "brochure.pdf", makePdf(["text"]));
    assert.deepEqual(Object.keys(ticket).sort(), ["documentId", "uploadUrl"]);
    assert.match(w.files.issued[0], new RegExp(`^projects/${p.id}/${ticket.documentId}/brochure\\.pdf$`));
  });
  it("identical filenames are safe: both uploads exist at different paths", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    await upload(ctx, w, p.id, "plan.pdf", makePdf(["version one of the plan"]));
    await upload(ctx, w, p.id, "plan.pdf", makePdf(["version two of the plan"]));
    assert.equal(new Set(w.files.issued).size, 2);
    assert.equal((await w.repoFor(ADMIN).listDocuments(p.id)).length, 2);
  });
  it("identical content is refused, and the row and file are cleaned up (no orphans)", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const bytes = makePdf(["the same brochure"]);
    await upload(ctx, w, p.id, "a.pdf", bytes);
    const { result } = await upload(ctx, w, p.id, "b.pdf", bytes);
    assert.ok(!result.ok && /identical/i.test(result.error));
    assert.equal((await w.repoFor(ADMIN).listDocuments(p.id)).length, 1);
    assert.equal(w.files.objects.size, 1);
  });
  it("rejects unsupported and oversized uploads before any row or URL exists", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    for (const [filename, mime, size] of [["x.exe", "application/octet-stream", 100], ["x.svg", "image/svg+xml", 100], ["x.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1], ["x.pdf", "application/pdf", 0]] as const) {
      await assert.rejects(beginUpload(ctx, { projectId: p.id, filename, mime, size, kind: "document" }), denied, filename);
    }
    assert.equal(w.files.issued.length, 0);
    assert.equal((await w.repoFor(ADMIN).listDocuments()).length, 0);
  });
  it("a file whose bytes do not match its extension is rejected after upload and fully removed", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { result } = await upload(ctx, w, p.id, "fake.pdf", JPG_BYTES, { kind: "brochure" });
    assert.ok(!result.ok && /does not match/.test(result.error));
    assert.equal(w.files.objects.size, 0);
    assert.equal((await w.repoFor(ADMIN).listDocuments()).length, 0);
  });
  it("a scanned PDF is kept but marked failed (no_text) with a retry path, never 'processed'", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { result } = await upload(ctx, w, p.id, "scan.pdf", makePdf(["", ""]));
    assert.ok(result.ok && result.document.status === "failed" && result.document.status_detail === "no_text");
    assert.equal((await w.repoFor(MEMBER).searchChunks("anything")).length, 0);
  });
  it("an image is stored as processed but is honest that its content is not searchable", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { result } = await upload(ctx, w, p.id, "render.jpg", JPG_BYTES, { kind: "rendering", title: "North elevation" });
    assert.ok(result.ok && result.document.status === "processed" && result.document.status_detail === "not_indexable");
    const hits = await w.repoFor(MEMBER).searchChunks("north elevation");
    assert.equal(hits.length, 1);
    assert.match(hits[0].content, /Rendering/);
  });
  it("cannot upload to an archived or unknown project", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    await archiveProject(ctx, p.id, true);
    await assert.rejects(beginUpload(ctx, { projectId: p.id, filename: "a.pdf", mime: "application/pdf", size: 10, kind: "brochure" }), (e) => denied(e) && /Archived/.test((e as Error).message));
    await assert.rejects(beginUpload(ctx, { projectId: "99999999-9999-4999-8999-999999999999", filename: "a.pdf", mime: "application/pdf", size: 10, kind: "brochure" }), denied);
  });
  it("a member cannot start an upload or finish one", async () => {
    const w = world();
    const p = await createProject(w.ctx(ADMIN), PROJECT);
    await assert.rejects(beginUpload(w.ctx(MEMBER), { projectId: p.id, filename: "a.pdf", mime: "application/pdf", size: 10, kind: "brochure" }), denied);
    await assert.rejects(finishUpload(w.ctx(MEMBER), { documentId: p.id }), denied);
  });
  it("a storage failure while starting an upload leaves no pending row behind", async () => {
    const w = world();
    const p = await createProject(w.ctx(ADMIN), PROJECT);
    const broken = { ...w.files, createUpload: async () => { throw new Error("boom"); } };
    await assert.rejects(beginUpload(w.ctx(ADMIN, { files: broken }), { projectId: p.id, filename: "a.pdf", mime: "application/pdf", size: 10, kind: "brochure" }), denied);
    assert.equal((await w.repoFor(ADMIN).listDocuments()).length, 0);
  });
  it("finishing an upload for a file that never arrived fails cleanly", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const t = await beginUpload(ctx, { projectId: p.id, filename: "a.pdf", mime: "application/pdf", size: 10, kind: "brochure" });
    const r = await finishUpload(ctx, { documentId: t.documentId });
    assert.ok(!r.ok && /could not be found/.test(r.error));
    assert.equal((await w.repoFor(ADMIN).listDocuments()).length, 0);
  });
  it("cannot finish the same upload twice", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["x y z"]));
    await assert.rejects(finishUpload(ctx, { documentId: ticket.documentId }), denied);
  });
});

describe("reprocess, replace, remove", () => {
  it("reprocessing replaces chunks instead of duplicating them", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["alpha beta gamma"]));
    const before = w.store.chunks.length;
    const again = await reprocessDocument(ctx, ticket.documentId);
    assert.equal(again.status, "processed");
    assert.equal(again.attempts, 2);
    assert.equal(w.store.chunks.length, before);
  });
  it("a document processed by an older extractor shows as needing reprocessing, and reprocessing clears it", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["alpha beta gamma"]));
    w.store.documents[0].extractor_version = 0;
    assert.equal((await w.repoFor(MEMBER).getDocument(ticket.documentId))!.status, "needs_reprocessing");
    await reprocessDocument(ctx, ticket.documentId);
    assert.equal((await w.repoFor(MEMBER).getDocument(ticket.documentId))!.status, "processed");
  });
  it("removal deletes the file, the row and the chunks together", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["delete me please"]));
    await removeDocument(ctx, ticket.documentId);
    assert.equal(w.files.objects.size, 0);
    assert.equal(w.store.documents.length, 0);
    assert.equal(w.store.chunks.length, 0);
  });
  it("if storage removal fails nothing is deleted, so the document stays complete and retryable", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["keep me when storage fails"]));
    w.files.failRemove(true);
    await assert.rejects(removeDocument(ctx, ticket.documentId), (e) => denied(e) && /nothing was deleted/.test((e as Error).message));
    assert.equal(w.store.documents.length, 1);
    assert.equal(w.files.objects.size, 1);
    w.files.failRemove(false);
    await removeDocument(ctx, ticket.documentId);
    assert.equal(w.store.documents.length, 0);
  });
  it("replacing a document removes the old one only after the new one is processed", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket: old } = await upload(ctx, w, p.id, "v1.pdf", makePdf(["old brochure text"]));
    const t = await beginUpload(ctx, { projectId: p.id, filename: "v2.pdf", mime: "application/pdf", size: 100, kind: "brochure" });
    w.files.put(t.uploadUrl, makePdf(["new brochure text"]));
    const r = await finishUpload(ctx, { documentId: t.documentId, replaces: old.documentId });
    assert.ok(r.ok);
    const docs = await w.repoFor(ADMIN).listDocuments(p.id);
    assert.deepEqual(docs.map((d) => d.id), [t.documentId]);
    // a failed replacement leaves the old one in place
    const bad = await beginUpload(ctx, { projectId: p.id, filename: "v3.pdf", mime: "application/pdf", size: 100, kind: "brochure" });
    w.files.put(bad.uploadUrl, JPG_BYTES);
    const failed = await finishUpload(ctx, { documentId: bad.documentId, replaces: t.documentId });
    assert.ok(!failed.ok);
    assert.equal((await w.repoFor(ADMIN).listDocuments(p.id)).length, 1);
  });
  it("a short-lived link is issued to a member for a visible document only", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "a.pdf", makePdf(["x y z"]));
    assert.match(await documentLink(w.ctx(MEMBER), ticket.documentId), /ttl=60$/);
    assert.match(await documentLink(w.ctx(MEMBER), ticket.documentId, { download: true }), /dl=a\.pdf/);
    await archiveProject(ctx, p.id, true);
    await assert.rejects(documentLink(w.ctx(MEMBER), ticket.documentId), denied);
    await assert.rejects(documentLink(w.ctx(MEMBER), "not-an-id"), denied);
  });
});

describe("inventory import: preview first, never silently overwrite", () => {
  const sheet = [["Unit", "Type", "Beds", "Baths", "Sq Ft", "Price", "Status", "Occupancy"], ["1204", "2 Bed", 2, 2, 850, 799000, "Available", "2028-09-30"], ["1205", "1 Bed", 1, 1, 600, 599000, "Sold", ""], ["1206", "Studio", "Studio", 1, 400, "$450,000", "Reserved", ""]];
  async function setup() {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "inventory.xlsx", makeXlsx(sheet));
    return { w, ctx, p, id: ticket.documentId };
  }
  it("previews without writing anything", async () => {
    const { w, ctx, id } = await setup();
    const { preview } = await previewInventoryImport(ctx, id);
    assert.deepEqual(preview.counts, { new: 3, duplicate: 0, conflict: 0, error: 0 });
    assert.equal(preview.rows[2].data!.price, 450000);
    assert.equal(preview.rows[2].data!.bedrooms, 0);
    assert.equal(w.store.inventory.length, 0);
  });
  it("commits new rows, links them to the source document and records them as unverified", async () => {
    const { w, ctx, id } = await setup();
    const out = await commitInventoryImport(ctx, { documentId: id, mode: "insert_only", skipErrors: false });
    assert.equal(out.inserted, 3);
    assert.equal(w.store.inventory.length, 3);
    assert.ok(w.store.inventory.every((u) => u.source_document_id === id && u.verified_at === null && u.source === "import: inventory.xlsx"));
    assert.equal(w.store.inventory[1].availability, "sold");
  });
  it("re-importing the same file is all duplicates and writes nothing", async () => {
    const { w, ctx, id } = await setup();
    await commitInventoryImport(ctx, { documentId: id, mode: "insert_only", skipErrors: false });
    const again = await commitInventoryImport(ctx, { documentId: id, mode: "insert_only", skipErrors: false });
    assert.deepEqual(again, { inserted: 0, updated: 0, skipped_duplicates: 3, skipped_conflicts: 0, skipped_errors: 0 });
    assert.equal(w.store.inventory.length, 3);
  });
  it("a changed price is a CONFLICT that is not applied unless explicitly requested", async () => {
    const { w, ctx, p, id } = await setup();
    await commitInventoryImport(ctx, { documentId: id, mode: "insert_only", skipErrors: false });
    const changed = sheet.map((r, i) => (i === 1 ? ["1204", "2 Bed", 2, 2, 850, 825000, "Reserved", "2028-09-30"] : r));
    const { ticket } = await upload(ctx, w, p.id, "inventory-v2.xlsx", makeXlsx(changed));
    const prev = await previewInventoryImport(ctx, ticket.documentId);
    assert.equal(prev.preview.counts.conflict, 1);
    assert.deepEqual(prev.preview.rows[0].changes.map((c) => c.field).sort(), ["availability", "price"]);
    const kept = await commitInventoryImport(ctx, { documentId: ticket.documentId, mode: "insert_only", skipErrors: false });
    assert.equal(kept.skipped_conflicts, 1);
    assert.equal(w.store.inventory.find((u) => u.unit_number === "1204")!.price, 799000);
    w.repoFor(ADMIN).verifyInventory(w.store.inventory[0].id, true);
    const upd = await commitInventoryImport(ctx, { documentId: ticket.documentId, mode: "update_conflicts", skipErrors: false });
    assert.equal(upd.updated, 1);
    const unit = w.store.inventory.find((u) => u.unit_number === "1204")!;
    assert.equal(unit.price, 825000);
    assert.equal(unit.verified_at, null, "a changed record must be re-verified by a person");
    assert.equal(unit.source, "import: inventory-v2.xlsx");
  });
  it("rows with errors are never imported and need an explicit confirmation to skip", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const csv = utf8("Unit,Beds,Price,Status\n101,2,500000,Available\n102,two??,abc,Available\n103,1,300000,Maybe\n101,1,1,Sold\n");
    const { ticket } = await upload(ctx, w, p.id, "bad.csv", csv);
    const { preview } = await previewInventoryImport(ctx, ticket.documentId);
    assert.equal(preview.counts.error, 3);
    assert.match(preview.rows[3].errors[0], /more than once/);
    await assert.rejects(commitInventoryImport(ctx, { documentId: ticket.documentId, mode: "insert_only", skipErrors: false }), denied);
    const out = await commitInventoryImport(ctx, { documentId: ticket.documentId, mode: "insert_only", skipErrors: true });
    assert.equal(out.inserted, 1);
    assert.equal(out.skipped_errors, 3);
  });
  it("blank cells never invent data: availability stays unknown and price stays empty", async () => {
    const w = world(); const ctx = w.ctx(ADMIN);
    const p = await createProject(ctx, PROJECT);
    const { ticket } = await upload(ctx, w, p.id, "sparse.csv", utf8("Unit,Price,Status\n201,,\n"));
    await commitInventoryImport(ctx, { documentId: ticket.documentId, mode: "insert_only", skipErrors: false });
    assert.equal(w.store.inventory[0].price, null);
    assert.equal(w.store.inventory[0].availability, "unknown");
  });
  it("a rejected mapping cannot point at a missing or reused column", async () => {
    const { ctx, id } = await setup();
    await assert.rejects(previewInventoryImport(ctx, id, { price: 50 }), denied);
    await assert.rejects(previewInventoryImport(ctx, id, { price: 1, unit_type: 1 }), denied);
    await assert.rejects(previewInventoryImport(ctx, id, { nonsense: 1 }), denied);
  });
  it("only administrators can preview or commit, and only spreadsheets can be imported", async () => {
    const { w, ctx, p, id } = await setup();
    await assert.rejects(previewInventoryImport(w.ctx(MEMBER), id), denied);
    await assert.rejects(commitInventoryImport(w.ctx(MEMBER), { documentId: id, mode: "insert_only", skipErrors: false }), denied);
    const { ticket: pdf } = await upload(ctx, w, p.id, "b.pdf", makePdf(["not a sheet"]));
    await assert.rejects(previewInventoryImport(ctx, pdf.documentId), (e) => denied(e) && /CSV and XLSX/.test((e as Error).message));
  });
  it("verification is a deliberate administrator action", async () => {
    const { w, ctx, id } = await setup();
    await commitInventoryImport(ctx, { documentId: id, mode: "insert_only", skipErrors: false });
    const unit = w.store.inventory[0];
    await assert.rejects(verifyInventory(w.ctx(MEMBER), unit.id, true), denied);
    await verifyInventory(ctx, unit.id, true);
    assert.ok(unit.verified_at);
    await verifyInventory(ctx, unit.id, false);
    assert.equal(unit.verified_at, null);
  });
});
