import type { Profile } from "@/lib/types";
import type { Capability, ConnectionRef, Grant, ProviderId, RegisteredResource } from "./types";

/**
 * Pure authorization rules (no I/O), so they can be tested exhaustively. Fail closed: anything that does not positively match is denied.
 *
 *  - personal connection: usable only by its owner (and only while active). Role does not matter: an administrator cannot read an
 *    employee's personal connection either.
 *  - organization connection: usable only through resources that were explicitly registered AND whose visibility policy admits the
 *    caller. A connection with no registered resource grants nothing, whatever the token can reach.
 *  - "*" (whole workspace) exists only for the legacy shared-token connection.
 */

export const WORKSPACE_WIDE = "*";

/** Ids compared case-insensitively and without dashes, so a Notion id matches however it is written. */
export const canonicalId = (id: string): string => id.trim().replace(/-/g, "").toLowerCase();

const usable = (c: ConnectionRef, provider: ProviderId, capability: Capability): boolean =>
  c.provider === provider && c.status === "active" && c.capabilities.includes(capability);

export const ownsPersonalConnection = (user: Pick<Profile, "id">, c: ConnectionRef): boolean =>
  c.kind === "personal" && typeof c.owner_id === "string" && c.owner_id.length > 0 && typeof user.id === "string" && c.owner_id === user.id;

export const visibleTo = (user: Pick<Profile, "role">, r: RegisteredResource): boolean =>
  r.visibility === "org_members" || (r.visibility === "admins" && user.role === "admin");

/**
 * What this employee may use of one connection. Returns null when nothing. `resources` must be that connection's own registrations;
 * registrations that name another connection are ignored.
 */
export function grantFor(user: Profile, c: ConnectionRef, resources: readonly RegisteredResource[], provider: ProviderId, capability: Capability): Grant | null {
  if (!user || typeof user.id !== "string" || !user.id) return null;
  if (!usable(c, provider, capability)) return null;
  if (c.kind === "personal") return ownsPersonalConnection(user, c) ? { connection: c, scope: "all" } : null;
  if (c.kind !== "organization" || c.owner_id !== null) return null;
  const mine = resources.filter((r) => r.connection_id === c.id && visibleTo(user, r));
  if (c.legacy === true && mine.some((r) => r.provider_resource_id === WORKSPACE_WIDE)) return { connection: c, scope: "all" };
  const ids = new Set(mine.filter((r) => r.provider_resource_id !== WORKSPACE_WIDE).map((r) => canonicalId(r.provider_resource_id)).filter(Boolean));
  return ids.size > 0 ? { connection: c, scope: { ids } } : null;
}

/** May this grant expose a record with this id and parent id? A registered page covers itself, a registered database covers its rows. */
export function grantAllows(g: Grant, ...ids: (string | undefined)[]): boolean {
  if (g.scope === "all") return true;
  const set = g.scope.ids;
  return ids.some((id) => typeof id === "string" && id.length > 0 && set.has(canonicalId(id)));
}
