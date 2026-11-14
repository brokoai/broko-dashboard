import { failed, retrieve, type Outcome, type Outcomes, type ReadableSource } from "../chat/retrieval";
import type { Loaded } from "../chat/knowledge";
import type { BrainChatContext } from "../chat/types";
import { defaultRuntime, frameworkEnabled } from "../integrations/legacy";
import { scopedNotionConnector } from "../integrations/scoped-notion";
import { unavailableConnectors, type Connectors } from "./connectors";
import { notionConnectorFromEnv } from "./notion";
import { memoryTools } from "./memory-tools";
import { BROKO_TOOL_FOR_SOURCE, phase1Tools, runTool, ToolRegistry, type ToolContext } from "./tools";

/**
 * The Brain reads Tasks, Activity, Notifications, AI Inbox, Integrations and approved Knowledge ONLY through the tool registry.
 * The tools wrap the existing adapters (no second implementation), so authorization, user scoping, Knowledge approval rules,
 * provenance and honest "unavailable" reports are exactly what they were. What the registry adds is one place that validates,
 * permission-checks, time-limits and (for external data later) sanitises every read.
 */

let standard: ToolRegistry | undefined;
/** The shared registry: the Phase 1 contracts plus the read-only organizational-memory tools (contracts are stateless and per-request context is passed in, so one instance is safe). */
export const standardRegistry = (): ToolRegistry => (standard ??= new ToolRegistry([...phase1Tools(), ...memoryTools()]));
const registryOf = (ctx: BrainChatContext): ToolRegistry => ctx.tools ?? standardRegistry();

/**
 * Connectors for one request. Only a LIVE session can ever reach an external system: the demo (synthetic, passwordless visitors) never does,
 * whatever the environment holds. Without a configured credential every connector answers "not connected".
 */
/**
 * LOCAL DEVELOPMENT ONLY: lets the demo backend use Notion so the connector can be tried without Supabase. It needs ALL of: the explicit
 * flag BROKO_NOTION_IN_DEMO=1, NODE_ENV=development (`next dev`; never `next start` or a build), and no Vercel environment variable.
 * Anything else keeps the demo away from Notion, because the public demo serves anonymous visitors and Notion access is workspace-wide.
 */
export const notionAllowedInDemo = (env: Record<string, string | undefined>): boolean =>
  env.BROKO_NOTION_IN_DEMO === "1" && env.NODE_ENV === "development" && !env.VERCEL && !env.VERCEL_ENV && !env.VERCEL_URL;

export function connectorsFor(ctx: BrainChatContext, env: Record<string, string | undefined> = process.env): Connectors {
  if (ctx.connectors) return ctx.connectors;
  const base = unavailableConnectors();
  if (ctx.mode !== "live" && !notionAllowedInDemo(env)) return base;
  // Connection framework (flag, default off): Notion is assembled for THIS employee from the connections they may use. The shared
  // environment token only takes part as the admin-only legacy organization connection, and only when its own flag is on.
  if (frameworkEnabled(env)) return { ...base, notion: scopedNotionConnector(ctx.integrations ?? defaultRuntime(env, ctx.now), ctx.user) };
  const notion = notionConnectorFromEnv(env, ctx.now);
  return notion ? { ...base, notion } : base;
}

const toolContext = (ctx: BrainChatContext, got?: Outcomes): ToolContext => ({ user: ctx.user, now: ctx.now, brain: ctx, connectors: connectorsFor(ctx), ...(got ? { got } : {}) });

/** Runs any registered tool for the Brain with this request's registry, user and connectors. */
export const runBrainTool = (ctx: BrainChatContext, id: string, input: unknown) => runTool(registryOf(ctx), id, input, toolContext(ctx));

/**
 * Runs one source through its tool. If the tool produced its own Outcome (including a refusal such as "not connected") that exact
 * Outcome is used. If the tool itself failed (timeout, permission, unexpected error) the source is reported as unavailable, with the
 * same fixed wording the adapters use for a failed read, and nothing is substituted.
 */
async function viaTool(ctx: BrainChatContext, source: ReadableSource | "knowledge", got?: Outcomes): Promise<{ native: unknown; fallback: Outcome }> {
  const r = await runTool(registryOf(ctx), BROKO_TOOL_FOR_SOURCE[source], {}, toolContext(ctx, got));
  return { native: r.native, fallback: failed(source) };
}

/** Same contract as `retrieve()` (same dependency order, same shared `got` map); each adapter runs through its registry tool. */
export function retrieveViaTools(ctx: BrainChatContext, ids: ReadableSource[]): Promise<Outcomes> {
  return retrieve(ctx, ids, async (id, got) => {
    const { native, fallback } = await viaTool(ctx, id, got);
    return isOutcome(native) ? native : fallback;
  });
}

/** The approved Knowledge set (items, project names, withheld count) through `broko.knowledge.list`. */
export async function loadKnowledgeViaTools(ctx: BrainChatContext): Promise<Loaded> {
  const { native, fallback } = await viaTool(ctx, "knowledge");
  if (isLoaded(native)) return native;
  return { outcome: fallback, items: [], projectNames: new Map(), withheld: 0 };
}

const isOutcome = (v: unknown): v is Outcome => typeof v === "object" && v !== null && "ok" in v && "records" in v && "report" in v;
const isLoaded = (v: unknown): v is Loaded => typeof v === "object" && v !== null && "outcome" in v && "items" in v && isOutcome((v as Loaded).outcome);
