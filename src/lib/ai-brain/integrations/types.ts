import type { Profile } from "@/lib/types";
import type { NotionConnector } from "../assistant/connectors";

/**
 * Connection framework, Phase A: contracts only. Nothing here stores a credential, starts an OAuth flow or talks to a provider.
 * See docs/ai-brain/INTEGRATIONS_FRAMEWORK.md. Four things are kept apart on purpose:
 *   A  the provider grant (a token that exists for one provider user),            -> ConnectionRef (+ credentials, later)
 *   B  what that grant can reach (the provider's own picker / scopes),            -> the provider client
 *   C  which Broko employee may receive answers derived from it,                  -> authorize.ts (owner-only for personal connections)
 *   D  what the organization has chosen to share, per resource, with a policy,    -> RegisteredResource
 * Reach (B) is never an access rule. Only C and D are.
 */

export type ProviderId = "notion" | "outlook_mail" | "outlook_calendar" | "teams";
export type Capability = "documents" | "mail" | "calendar" | "chat" | "meeting_transcripts";

/** personal: one employee's own grant, usable ONLY for that employee. organization: a shared grant, usable only through registered resources. */
export type ConnectionKind = "personal" | "organization";
export type ConnectionStatus = "active" | "needs_reauth" | "revoked" | "disconnected" | "error";

/** Metadata about a connection. Deliberately has no token, no refresh token and no secret of any kind. */
export interface ConnectionRef {
  id: string;
  provider: ProviderId;
  kind: ConnectionKind;
  /** The employee a personal connection belongs to. Always null for an organization connection. */
  owner_id: string | null;
  status: ConnectionStatus;
  capabilities: Capability[];
  workspace_id?: string;
  workspace_name?: string;
  /** The pre-framework shared environment token. The only connection that may carry a workspace-wide ("*") resource. */
  legacy?: boolean;
}

/** Who inside the organization may see content that comes through an organization connection. There is no "everyone who is signed in" shortcut. */
export type ResourceVisibility = "org_members" | "admins";

/** One resource an administrator explicitly registered on an organization connection, with its visibility policy. */
export interface RegisteredResource {
  connection_id: string;
  /** The provider's id for the page, database or folder. "*" (whole workspace) is honored only for the legacy connection. */
  provider_resource_id: string;
  visibility: ResourceVisibility;
}

/**
 * Where connection metadata comes from. A real store (Phase B+) reads the database under RLS; the framework still re-checks everything it
 * returns, so a store that over-returns (another employee's connection) cannot widen access.
 */
export interface ConnectionStore {
  /** Connections this employee might use: their own personal ones and the organization's. */
  connectionsFor(userId: string, provider: ProviderId): Promise<ConnectionRef[]>;
  /** Registered resources of one organization connection. */
  resourcesOf(connectionId: string): Promise<RegisteredResource[]>;
}

/**
 * Turns a connection into a provider client. SERVER ONLY. Decryption of credentials (Phase C) happens inside an implementation of this
 * and the client it returns keeps the token in its closure; nothing else ever sees it. Returns null when no usable client can be built.
 */
export interface ClientFactory {
  notion?: (connection: ConnectionRef) => Promise<NotionConnector | null>;
}

export interface IntegrationRuntime { store: ConnectionStore; clients: ClientFactory }

/** What a request may use of one connection: everything it reaches (personal / legacy workspace-wide), or only the listed resource ids. */
export interface Grant { connection: ConnectionRef; scope: "all" | { ids: ReadonlySet<string> } }

export type Resolution = { ok: true; grants: Grant[] } | { ok: false; reason: "not_connected" | "error" };

// ---- provider contract (declared now, implemented per provider from Phase B) --------------------------------------------------

/** Opaque to everything except the provider module and the credential store. Never logged, returned or put in a prompt. */
export type Credentials = { readonly __brand: "credentials" } & Record<string, unknown>;

export interface ProviderAccount { workspace_id: string; workspace_name?: string; provider_user_id?: string }
export interface OAuthContract {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ account: ProviderAccount; credentials: Credentials }>;
  /** Providers that rotate refresh tokens return the NEW pair; the caller replaces the stored pair atomically. */
  refresh?(credentials: Credentials): Promise<Credentials>;
  revoke?(credentials: Credentials): Promise<void>;
}

export interface IntegrationProvider<Client = unknown> {
  id: ProviderId;
  label: string;
  capabilities: readonly Capability[];
  oauth?: OAuthContract;
  /** Builds the read-only client for one connection from its decrypted credentials. */
  client(connection: ConnectionRef, credentials: Credentials): Client;
}

export const PROVIDER_CATALOG: Readonly<Record<ProviderId, { label: string; capabilities: readonly Capability[] }>> = {
  notion: { label: "Notion", capabilities: ["documents"] },
  outlook_mail: { label: "Outlook Email", capabilities: ["mail"] },
  outlook_calendar: { label: "Outlook Calendar", capabilities: ["calendar"] },
  teams: { label: "Microsoft Teams", capabilities: ["chat", "meeting_transcripts"] },
};

export type { Profile };
