/**
 * LIVE verification of the Pre-Construction Advisor against the DEVELOPMENT Supabase project. NOT part of `npm test`
 * (it is not named *.test.ts and it needs a real project). It runs the app's real service code, repository and storage
 * adapter, plus direct API calls that bypass the app, so it proves what the database and Storage enforce.
 *
 * Preconditions (the owner does these; nothing here creates users or applies migrations):
 *   - migrations 0001, 0002, 0006, 0007 applied to broko-dev, a backup taken first
 *   - two SYNTHETIC users exist in Auth: one profile with role admin, one with role member
 *
 * Run (credentials in the environment, never in a file, never in chat):
 *   PRECON_LIVE_URL=https://olngcbgkxbceqpikcyxk.supabase.co PRECON_LIVE_ANON_KEY=... \
 *   PRECON_LIVE_ADMIN_EMAIL=... PRECON_LIVE_ADMIN_PASSWORD=... PRECON_LIVE_MEMBER_EMAIL=... PRECON_LIVE_MEMBER_PASSWORD=... \
 *   PRECON_LIVE_CONFIRM=broko-dev node --conditions=react-server --import tsx tests/live/precon-live-dev.script.ts
 *
 * It uses only the public anon key and user sessions (never a service-role key), writes only synthetic "[LIVE-TEST]" rows,
 * removes the files and documents it creates, archives its test project, and prints PASS/FAIL per check with no secrets.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { askBrain } from "../../src/lib/ai-brain/chat";
import { PROFILE_COLUMNS, toProfile, type ProfileRow } from "../../src/lib/backend/supabase/profile";
import { createSupabaseFileStore, createSupabasePreconRepo, PRECON_BUCKET } from "../../src/lib/backend/supabase/precon";
import type { Repo } from "../../src/lib/backend/types";
import type { PreconContext } from "../../src/lib/precon/service";
import {
  archiveProject, beginUpload, commitInventoryImport, createProject, documentLink, finishUpload, previewInventoryImport, removeDocument, reprocessDocument,
} from "../../src/lib/precon/service";
import type { Profile } from "../../src/lib/types";
import { fakeRepo } from "../ai-chat-helpers";
import { JPG_BYTES, makePdf, makeXlsx } from "../precon-fixtures";

const DEV_REF = "olngcbgkxbceqpikcyxk";
const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k}`); process.exit(2); }
  return v;
};

const url = need("PRECON_LIVE_URL");
const anon = need("PRECON_LIVE_ANON_KEY");
// Hard guard: only the approved development project. The other project in the organisation, and Production, are refused.
if (new URL(url).hostname.split(".")[0] !== DEV_REF || process.env.PRECON_LIVE_CONFIRM !== "broko-dev") {
  console.error("Refusing to run: the URL is not the approved development project, or PRECON_LIVE_CONFIRM=broko-dev is missing.");
  process.exit(2);
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const denied = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);

async function signIn(emailKey: string, passKey: string): Promise<{ db: SupabaseClient; profile: Profile }> {
  const db = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.auth.signInWithPassword({ email: need(emailKey), password: need(passKey) });
  if (error) { console.error(`Sign-in failed for ${emailKey}: ${error.message}`); process.exit(2); }
  const { data: u } = await db.auth.getUser();
  const { data: row } = await db.from("profiles").select(PROFILE_COLUMNS).eq("id", u.user!.id).maybeSingle();
  if (!row) { console.error("No profile row for the signed-in user."); process.exit(2); }
  return { db, profile: toProfile(row as ProfileRow, u.user!.email) };
}

const ctxFor = (db: SupabaseClient, profile: Profile): PreconContext => ({ user: profile, repo: createSupabasePreconRepo(db, profile), files: createSupabaseFileStore(db), log: () => undefined });

/** The browser's step: PUT raw bytes to the signed upload URL, with and without the apikey header. */
async function putTo(uploadUrl: string, bytes: Uint8Array, mime: string, withApikey: boolean) {
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime, ...(withApikey ? { apikey: anon } : {}) }, body: bytes as unknown as BodyInit });
  return { status: res.status, ok: res.ok };
}

async function main() {
  const admin = await signIn("PRECON_LIVE_ADMIN_EMAIL", "PRECON_LIVE_ADMIN_PASSWORD");
  const member = await signIn("PRECON_LIVE_MEMBER_EMAIL", "PRECON_LIVE_MEMBER_PASSWORD");
  check("setup: admin profile has role admin", admin.profile.role === "admin");
  check("setup: member profile has role member", member.profile.role === "member");
  const A = ctxFor(admin.db, admin.profile);
  const M = ctxFor(member.db, member.profile);

  // ---- 1. project access ----
  const project = await createProject(A, { name: `[LIVE-TEST] Tower ${Date.now()}`, developer: "Synthetic Dev", city: "Toronto", address: null, status: "selling", description: "Synthetic live test project.", expected_completion: "2028-09-30" });
  check("admin creates a project", !!project.id);
  const memberCreate = await createProject(M, { name: "[LIVE-TEST] member attempt", status: "selling" }).then(() => "created", (e) => denied(e));
  check("service refuses a member creating a project", memberCreate !== "created", memberCreate);
  const direct = await member.db.from("precon_projects").insert({ name: "[LIVE-TEST] direct member insert", status: "selling", created_by: member.profile.id });
  check("DATABASE refuses a member inserting a project directly (RLS)", !!direct.error, direct.error?.code);
  const directUpdate = await member.db.from("precon_projects").update({ name: "hacked" }).eq("id", project.id).select("id");
  check("DATABASE: a member update of a project changes nothing", !directUpdate.error ? (directUpdate.data ?? []).length === 0 : true, directUpdate.error?.code ?? "0 rows");
  const seen = await M.repo!.getProject(project.id);
  check("member can READ an active project", seen?.id === project.id);

  // ---- 2. signed upload (with / without apikey), validation, extraction ----
  const pdfBytes = makePdf(["Welcome to the LIVE-TEST tower brochure.", "Amenities include a rooftop pool and 24 hour concierge. Occupancy expected in 2029."]);
  const t1 = await beginUpload(A, { projectId: project.id, filename: "brochure.pdf", mime: "application/pdf", size: pdfBytes.byteLength, kind: "brochure" });
  const noKey = await putTo(t1.uploadUrl, pdfBytes, "application/pdf", false);
  let uploaded = noKey.ok;
  check("signed upload works WITHOUT an apikey header (informational)", noKey.ok, `status ${noKey.status}`);
  if (!noKey.ok) {
    const withKey = await putTo(t1.uploadUrl, pdfBytes, "application/pdf", true);
    uploaded = withKey.ok;
    check("signed upload works WITH the apikey header (the browser sends this)", withKey.ok, `status ${withKey.status}`);
  }
  if (uploaded) {
    const fin = await finishUpload(A, { documentId: t1.documentId });
    check("PDF is processed with text and page numbers", fin.ok && fin.document.status === "processed" && fin.document.chunk_count > 0 && fin.document.page_count === 2, fin.ok ? `${fin.document.status}, ${fin.document.chunk_count} chunks` : fin.error);
    const hits = await M.repo!.searchChunks("rooftop pool", { projectId: project.id });
    check("member's full-text search finds the PDF passage with its page", hits.length > 0 && hits[0].page === 2, `${hits.length} hits`);
    const link = await documentLink(M, t1.documentId).catch((e) => denied(e));
    check("member gets a short-lived signed link for a visible document", /^https?:\/\//.test(link) && /token=/.test(link));
    const fetched = /^https?:\/\//.test(link) ? await fetch(link) : null;
    check("the signed link actually downloads the file", !!fetched?.ok && (await fetched.arrayBuffer()).byteLength === pdfBytes.byteLength, fetched ? `status ${fetched.status}` : "no link");
  }

  // ---- 3. rejections and cleanup ----
  const fake = await beginUpload(A, { projectId: project.id, filename: "fake.pdf", mime: "application/pdf", size: JPG_BYTES.byteLength, kind: "brochure" });
  if ((await putTo(fake.uploadUrl, JPG_BYTES, "application/pdf", true)).ok) {
    const r = await finishUpload(A, { documentId: fake.documentId });
    check("a renamed file is rejected by content and fully cleaned up", !r.ok);
    const left = await A.repo!.getDocument(fake.documentId);
    check("no orphan document row after rejection", left === null);
  } else check("renamed-file upload reached storage", false);
  const big = await beginUpload(A, { projectId: project.id, filename: "x.pdf", mime: "application/pdf", size: 1000, kind: "brochure" });
  const exe = await putTo(big.uploadUrl, new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "application/x-msdownload", true);
  check("BUCKET rejects a disallowed content type", !exe.ok, `status ${exe.status}`);
  await A.repo!.deleteDocument(big.documentId).catch(() => undefined);
  const oversized = await beginUpload(A, { projectId: project.id, filename: "huge.pdf", mime: "application/pdf", size: 26 * 1024 * 1024, kind: "brochure" }).then(() => "accepted", (e) => denied(e));
  check("oversized upload is refused before any URL is issued", oversized !== "accepted", oversized);

  // ---- 4. inventory import ----
  const sheet = makeXlsx([["Unit", "Type", "Beds", "Baths", "Sq Ft", "Price", "Status", "Occupancy"], ["L-101", "2 Bed", 2, 2, 850, 799000, "Available", "2028-09-30"], ["L-102", "1 Bed", 1, 1, 600, 599000, "Sold", ""]]);
  const t2 = await beginUpload(A, { projectId: project.id, filename: "inventory.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: sheet.byteLength, kind: "inventory_sheet" });
  if ((await putTo(t2.uploadUrl, sheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true)).ok) {
    const fin2 = await finishUpload(A, { documentId: t2.documentId });
    check("XLSX is processed", fin2.ok && fin2.document.status === "processed", fin2.ok ? fin2.document.status : fin2.error);
    const prev = await previewInventoryImport(A, t2.documentId);
    check("import preview classifies both rows as new and writes nothing", prev.preview.counts.new === 2 && (await A.repo!.listInventory({ project_id: project.id })).length === 0);
    const out = await commitInventoryImport(A, { documentId: t2.documentId, mode: "insert_only", skipErrors: false });
    check("import commits 2 records", out.inserted === 2, JSON.stringify(out));
    const again = await commitInventoryImport(A, { documentId: t2.documentId, mode: "insert_only", skipErrors: false });
    check("re-import writes nothing (duplicates)", again.inserted === 0 && again.skipped_duplicates === 2);
  } else check("XLSX upload reached storage", false);

  // ---- 5. unit numbers ----
  const adminUnits = await A.repo!.listInventory({ project_id: project.id });
  const memberUnits = await M.repo!.listInventory({ project_id: project.id });
  check("admin sees unit numbers", adminUnits.some((u) => u.unit_number === "L-101"));
  check("member sees inventory but NO unit numbers", memberUnits.length === 2 && memberUnits.every((u) => u.unit_number === null));
  const rawUnit = await member.db.from("precon_inventory").select("unit_number").eq("project_id", project.id);
  check("DATABASE refuses a member selecting unit_number directly", !!rawUnit.error, rawUnit.error?.code);
  const rpc = await member.db.rpc("precon_unit_numbers", { p_project: project.id });
  check("precon_unit_numbers returns nothing to a member", !rpc.error && (rpc.data ?? []).length === 0, rpc.error?.code ?? "0 rows");

  // ---- 6. member cannot mutate or touch storage ----
  const docs = await M.repo!.listDocuments(project.id);
  const del = await member.db.from("precon_documents").delete().eq("id", docs[0]?.id ?? t1.documentId).select("id");
  check("DATABASE: a member cannot delete a document", !!del.error || (del.data ?? []).length === 0, del.error?.code ?? "0 rows");
  const stray = await member.db.storage.from(PRECON_BUCKET).createSignedUploadUrl(`projects/${project.id}/${project.id}/x.pdf`);
  check("STORAGE refuses a member a signed upload URL", !!stray.error, stray.error?.message?.slice(0, 80));
  const rm = await member.db.storage.from(PRECON_BUCKET).remove(["projects/none/none/none.pdf"]);
  check("STORAGE: a member remove deletes nothing", !!rm.error || (rm.data ?? []).length === 0);
  const memberReprocess = await reprocessDocument(M, t1.documentId).then(() => "ran", (e) => denied(e));
  check("service refuses a member reprocessing", memberReprocess !== "ran", memberReprocess);

  // ---- 7. Brain, project scoped ----
  const brainRepo = { ...fakeRepo().repo, precon: M.repo, preconFiles: M.files } as Repo;
  const reply = await askBrain({ user: member.profile, repo: brainRepo, mode: "live", now: new Date() }, "Which 2 bedroom units are available?", { projectId: project.id });
  check("Brain answers a project-scoped inventory question from structured records", reply.intent === "preconstruction" && /1 inventory record/.test(reply.text), reply.text.slice(0, 80));
  check("Brain reply contains no unit number for a member", !JSON.stringify(reply).includes("L-101"));
  const cited = await askBrain({ user: member.profile, repo: brainRepo, mode: "live", now: new Date() }, "What are the selling points?", { projectId: project.id });
  // The retrieval terms for "selling points" are selling / amenities / features / highlights / included, so the fixture page 2 says "Amenities".
  // Expect the exact source document AND page 2 (where the passage is), not just any document link.
  check("Brain cites the document and page", JSON.stringify(cited).includes(`/precon/documents/${t1.documentId}#p2`), JSON.stringify(cited.text ?? "").slice(0, 100));

  // ---- 8. archive hides from members; removal cleans up ----
  await archiveProject(A, project.id, true);
  check("archived project is invisible to a member", (await M.repo!.getProject(project.id)) === null);
  check("archived project's documents are invisible to a member", (await M.repo!.listDocuments(project.id)).length === 0);
  const hiddenDl = await member.db.storage.from(PRECON_BUCKET).download(`projects/${project.id}/${t1.documentId}/brochure.pdf`);
  check("STORAGE: archived project's file is not downloadable by a member", !!hiddenDl.error);
  await archiveProject(A, project.id, false);
  const mine = await A.repo!.listDocuments(project.id);
  for (const d of mine) await removeDocument(A, d.id);
  check("removal deletes files, rows and chunks", (await A.repo!.listDocuments(project.id)).length === 0 && (await A.repo!.searchChunks("rooftop", { projectId: project.id })).length === 0);
  await archiveProject(A, project.id, true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.${failed.length ? ` FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("Script error:", denied(e)); process.exit(2); });
