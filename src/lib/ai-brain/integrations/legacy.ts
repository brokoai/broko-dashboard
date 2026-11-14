import "server-only";
import { notionConnectorFromEnv } from "../assistant/notion";
import { WORKSPACE_WIDE } from "./authorize";
import type { ConnectionRef, ConnectionStore, IntegrationRuntime, RegisteredResource } from "./types";

/**
 * Feature flags. Both default OFF, so a deployment that sets neither behaves exactly as it did before the framework existed.
 *  BROKO_CONNECTION_FRAMEWORK=1       connectors are assembled per employee from their connections (this framework).
 *  BROKO_LEGACY_NOTION_CONNECTION=1   (framework on) also offer the shared environment token as ONE organization connection.
 */
export const frameworkEnabled = (env: Record<string, string | undefined>): boolean => env.BROKO_CONNECTION_FRAMEWORK === "1";
export const legacyNotionEnabled = (env: Record<string, string | undefined>): boolean => env.BROKO_LEGACY_NOTION_CONNECTION === "1";

export const LEGACY_NOTION_CONNECTION_ID = "legacy-env-notion";

/**
 * The shared environment token as an organization connection. Its token reaches the whole workspace and cannot be narrowed per page, so
 * its one registration is the workspace-wide marker with ADMIN-ONLY visibility. Members never get anything through it. It carries no
 * owner: it is not anyone's personal connection.
 */
const legacyConnection = (): ConnectionRef => ({
  id: LEGACY_NOTION_CONNECTION_ID, provider: "notion", kind: "organization", owner_id: null, status: "active",
  capabilities: ["documents"], workspace_name: "Shared Notion integration", legacy: true,
});
const legacyResource = (): RegisteredResource => ({ connection_id: LEGACY_NOTION_CONNECTION_ID, provider_resource_id: WORKSPACE_WIDE, visibility: "admins" });

/** The runtime used when nothing else is injected. There is no database store yet, so only the legacy connection can ever exist. */
export function defaultRuntime(env: Record<string, string | undefined>, now?: Date): IntegrationRuntime {
  const legacyOn = legacyNotionEnabled(env) && notionConnectorFromEnv(env, now) !== null;
  const store: ConnectionStore = {
    connectionsFor: async (_userId, provider) => (legacyOn && provider === "notion" ? [legacyConnection()] : []),
    resourcesOf: async (id) => (legacyOn && id === LEGACY_NOTION_CONNECTION_ID ? [legacyResource()] : []),
  };
  return {
    store,
    clients: { notion: async (c) => (c.legacy === true && c.id === LEGACY_NOTION_CONNECTION_ID ? notionConnectorFromEnv(env, now) : null) },
  };
}
