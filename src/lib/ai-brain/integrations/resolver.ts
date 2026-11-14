import type { Profile } from "@/lib/types";
import { grantFor } from "./authorize";
import type { Capability, ConnectionRef, Grant, IntegrationRuntime, ProviderId, RegisteredResource, Resolution } from "./types";

/**
 * Which connections this employee may use right now. Called on EVERY request and never cached, so a revoked or disconnected connection
 * stops being used on the next call and no stale content can be served. Personal grants come first, then organization grants.
 *
 * Fail closed: no signed-in employee, a store that throws, or no connection that passes the rules all end in "nothing may be read".
 */
export async function resolveGrants(rt: IntegrationRuntime, user: Profile, provider: ProviderId, capability: Capability): Promise<Resolution> {
  if (!user || typeof user.id !== "string" || !user.id) return { ok: false, reason: "not_connected" };
  let connections: ConnectionRef[];
  try {
    connections = await rt.store.connectionsFor(user.id, provider);
  } catch {
    return { ok: false, reason: "error" };
  }
  const grants: Grant[] = [];
  let failed = 0;
  for (const c of Array.isArray(connections) ? connections : []) {
    let resources: RegisteredResource[] = [];
    if (c?.kind === "organization") {
      try { resources = await rt.store.resourcesOf(c.id); } catch { failed += 1; continue; }
    }
    const g = c ? grantFor(user, c, resources, provider, capability) : null;
    if (g) grants.push(g);
  }
  if (grants.length === 0) return { ok: false, reason: failed > 0 ? "error" : "not_connected" };
  grants.sort((a, b) => Number(a.connection.kind === "organization") - Number(b.connection.kind === "organization"));
  return { ok: true, grants };
}
