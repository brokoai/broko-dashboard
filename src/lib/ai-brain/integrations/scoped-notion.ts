import type { Profile } from "@/lib/types";
import type { ConnectorFailure, ConnectorResult, ExternalRecord, NotionConnector } from "../assistant/connectors";
import type { MeetingCandidate, MeetingDocument } from "../assistant/meetings/types";
import { grantAllows } from "./authorize";
import { resolveGrants } from "./resolver";
import type { Grant, IntegrationRuntime } from "./types";

/**
 * A Notion connector for ONE employee, assembled from the connections they may use.
 *
 * Every call resolves the employee's grants again (no caching, so revocation is immediate), and every record that comes back is checked
 * against the grant that produced it before it is returned. Results from an organization connection that are not covered by a registered
 * resource are dropped; a lookup by id that no grant covers answers permission_denied and returns nothing.
 *
 * Failure order (never a partial leak): if any grant produced allowed data, that data is returned; otherwise permission_denied if a grant
 * read something it was not allowed to expose, otherwise the first failure reported.
 */

interface Part { grant: Grant; client: NotionConnector }

async function partsFor(rt: IntegrationRuntime, user: Profile): Promise<{ ok: true; parts: Part[] } | { ok: false; reason: ConnectorFailure }> {
  const res = await resolveGrants(rt, user, "notion", "documents");
  if (!res.ok) return res.reason === "not_connected" ? { ok: false, reason: "not_connected" } : { ok: false, reason: "error" };
  const parts: Part[] = [];
  for (const grant of res.grants) {
    try {
      const client = await rt.clients.notion?.(grant.connection);
      if (client) parts.push({ grant, client });
    } catch { /* no client for this connection: it contributes nothing */ }
  }
  return parts.length > 0 ? { ok: true, parts } : { ok: false, reason: "not_connected" };
}

const firstFailure = (fails: ConnectorFailure[]): ConnectorFailure => (fails.includes("permission_denied") ? "permission_denied" : fails[0] ?? "error");

/** Runs one listing on every part, keeps only what that part's grant covers, merges (first writer wins, personal first), trims to `limit`. */
async function list<T extends { record_id: string; parent_id?: string }>(
  parts: Part[], limit: number, call: (c: NotionConnector) => Promise<ConnectorResult<T[]>>,
): Promise<ConnectorResult<T[]>> {
  const settled = await Promise.all(parts.map(async (p) => ({ p, r: await call(p.client).catch((): ConnectorResult<T[]> => ({ ok: false, reason: "error" })) })));
  const seen = new Set<string>();
  const out: T[] = [];
  const fails: ConnectorFailure[] = [];
  for (const { p, r } of settled) {
    if (!r.ok) { fails.push(r.reason); continue; }
    for (const rec of r.data) {
      if (!grantAllows(p.grant, rec.record_id, rec.parent_id) || seen.has(rec.record_id)) continue;
      seen.add(rec.record_id);
      out.push(rec);
    }
  }
  if (out.length === 0 && fails.length === settled.length) return { ok: false, reason: firstFailure(fails) };
  return { ok: true, data: out.slice(0, Math.max(1, limit)) };
}

/** Tries each part in order for one record; the record is returned only if the grant that read it covers it. */
async function one<T extends { record_id: string; parent_id?: string }>(
  parts: Part[], call: (c: NotionConnector) => Promise<ConnectorResult<T>>,
): Promise<ConnectorResult<T>> {
  const fails: ConnectorFailure[] = [];
  for (const p of parts) {
    const r = await call(p.client).catch((): ConnectorResult<T> => ({ ok: false, reason: "error" }));
    if (!r.ok) { fails.push(r.reason); continue; }
    if (grantAllows(p.grant, r.data.record_id, r.data.parent_id)) return r;
    fails.push("permission_denied"); // read with this connection but not covered by it: discarded, never returned
  }
  return { ok: false, reason: firstFailure(fails) };
}

export function scopedNotionConnector(rt: IntegrationRuntime, user: Profile): NotionConnector {
  return {
    async searchPages(query, limit) {
      const s = await partsFor(rt, user);
      return s.ok ? list<ExternalRecord>(s.parts, limit, (c) => c.searchPages(query, limit)) : s;
    },
    async getPage(pageId) {
      const s = await partsFor(rt, user);
      return s.ok ? one<ExternalRecord>(s.parts, (c) => c.getPage(pageId)) : s;
    },
    async queryDatabase(databaseId, limit) {
      const s = await partsFor(rt, user);
      if (!s.ok) return s;
      // A database is read only through a grant that covers the database itself; its rows then inherit that cover.
      const covering = s.parts.filter((p) => grantAllows(p.grant, databaseId));
      if (covering.length === 0) return { ok: false, reason: "permission_denied" };
      const settled: ConnectorFailure[] = [];
      for (const p of covering) {
        const r = await p.client.queryDatabase(databaseId, limit).catch((): ConnectorResult<ExternalRecord[]> => ({ ok: false, reason: "error" }));
        if (r.ok) return r;
        settled.push(r.reason);
      }
      return { ok: false, reason: firstFailure(settled) };
    },
    async findMeetingCandidates(keywords, limit) {
      const s = await partsFor(rt, user);
      return s.ok ? list<MeetingCandidate>(s.parts, limit, (c) => c.findMeetingCandidates(keywords, limit)) : s;
    },
    async readMeetingDocument(pageId) {
      const s = await partsFor(rt, user);
      return s.ok ? one<MeetingDocument>(s.parts, (c) => c.readMeetingDocument(pageId)) : s;
    },
  };
}
