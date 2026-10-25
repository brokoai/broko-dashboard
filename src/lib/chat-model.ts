import "server-only";
import { createChatRouter, createMemoryRateLimiter, type ChatRouter, type ModelRateLimiter } from "@/lib/ai-brain/chat";
import { createModelTransport, loadAiBrainConfig } from "@/lib/ai-brain";

/** Why the chat has, or does not have, a model interpreter. Content-free: safe to log and to assert on. */
export type ChatRouterStatus =
  | { enabled: false; reason: "off" | "no_key" | "production_needs_durable_limiter" }
  | { enabled: true; limiter: "durable" | "in_memory" };

export interface ChatRouterResolution { router: ChatRouter | null; status: ChatRouterStatus }

/**
 * Decides whether the chat gets a model interpreter. It uses the SAME provider configuration as the email classifier
 * (loadAiBrainConfig -> createModelTransport: the one configured key and model) and is on only when BROKO_AI_CHAT=llm AND a
 * key is configured.
 *
 * COST CONTROL, FAIL CLOSED: the per-user budget must live in a store shared by every server instance. An in-memory limiter
 * resets on each serverless cold start and is not shared, so in production (NODE_ENV=production) the model is NOT used unless
 * a `durable` limiter is supplied. No durable limiter exists in this codebase yet (it would need an approved shared store, e.g.
 * a database table or a key-value service), so today production always falls back to deterministic routing. Outside production
 * (local development, tests) the in-memory limiter is allowed, because a single local process is a real budget.
 */
export function resolveChatRouter(env: NodeJS.ProcessEnv = process.env, durableLimiter?: ModelRateLimiter): ChatRouterResolution {
  const cfg = loadAiBrainConfig(env);
  if (cfg.chat !== "llm") return { router: null, status: { enabled: false, reason: "off" } };
  const transport = createModelTransport(cfg, { timeoutMs: 8_000 });
  if (!transport) return { router: null, status: { enabled: false, reason: "no_key" } };

  if (durableLimiter?.durable) return { router: createChatRouter({ transport, limiter: durableLimiter }), status: { enabled: true, limiter: "durable" } };
  if (env.NODE_ENV === "production") return { router: null, status: { enabled: false, reason: "production_needs_durable_limiter" } };
  return { router: createChatRouter({ transport, limiter: createMemoryRateLimiter() }), status: { enabled: true, limiter: "in_memory" } };
}

let resolved: ChatRouterResolution | undefined;

/** The chat's model interpreter, or null (deterministic routing only). Built once per server instance. */
export function chatRouter(env: NodeJS.ProcessEnv = process.env): ChatRouter | null {
  if (!resolved) {
    resolved = resolveChatRouter(env);
    if (!resolved.status.enabled && resolved.status.reason === "production_needs_durable_limiter") {
      console.warn("[chat] BROKO_AI_CHAT=llm is ignored in production: no durable rate limiter is configured, so chat stays deterministic.");
    }
  }
  return resolved.router;
}
