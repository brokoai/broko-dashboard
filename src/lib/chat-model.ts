import "server-only";
import { createChatRouter, createMemoryRateLimiter, createSynthesizer, redisLimiterFromEnv, type ChatRouter, type ModelRateLimiter, type Synthesizer } from "@/lib/ai-brain/chat";
import { createModelTransport, loadAiBrainConfig } from "@/lib/ai-brain";
import { createToolTransport } from "@/lib/ai-brain/model-tool-transport";
import { createToolAgent, type ToolAgent } from "@/lib/ai-brain/chat/tool-agent";
import { createInterpreter, type Interpreter } from "@/lib/ai-brain/chat/interpreter";
import { RELATIONSHIP_TOOL, relationshipsEnabled } from "@/lib/ai-brain/assistant/memory-tools";

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
    resolved = resolveChatRouter(env, redisLimiterFromEnv(env) ?? undefined);
    if (!resolved.status.enabled && resolved.status.reason === "production_needs_durable_limiter") {
      console.warn("[chat] BROKO_AI_CHAT=llm is ignored in production: no durable rate limiter is configured, so chat stays deterministic.");
    }
  }
  return resolved.router;
}

// ---- grounded analysis (meetings) ------------------------------------------------------------------------------------------

export interface SynthesizerResolution { synthesizer: Synthesizer | null; status: ChatRouterStatus }

const intEnv = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : d);

/**
 * The model that ANALYSES retrieved content (it is handed records the Brain already authorized; see chat/synthesizer.ts). Same provider,
 * key and model as everything else, same on/off switch (BROKO_AI_CHAT=llm plus a key), same fail-closed production rule, but its OWN budget:
 * per user 10 per hour and 100 per day across everyone by default (BROKO_AI_SYNTH_USER_MAX / BROKO_AI_SYNTH_GLOBAL_MAX), because one analysis
 * costs far more than a routing call. Production without a durable limiter gets no model at all and the deterministic reply is used.
 */
export function resolveChatSynthesizer(env: NodeJS.ProcessEnv = process.env, durableLimiter?: ModelRateLimiter): SynthesizerResolution {
  const cfg = loadAiBrainConfig(env);
  if (cfg.chat !== "llm") return { synthesizer: null, status: { enabled: false, reason: "off" } };
  const transport = createModelTransport(cfg, { timeoutMs: 25_000 });
  if (!transport) return { synthesizer: null, status: { enabled: false, reason: "no_key" } };
  if (durableLimiter?.durable) return { synthesizer: createSynthesizer({ transport, limiter: durableLimiter }), status: { enabled: true, limiter: "durable" } };
  if (env.NODE_ENV === "production") return { synthesizer: null, status: { enabled: false, reason: "production_needs_durable_limiter" } };
  return { synthesizer: createSynthesizer({ transport, limiter: createMemoryRateLimiter({ maxCalls: intEnv(env.BROKO_AI_SYNTH_USER_MAX, 10), windowMs: 3_600_000 }) }), status: { enabled: true, limiter: "in_memory" } };
}

let resolvedSynth: SynthesizerResolution | undefined;

/** The chat's analysis model, or null (deterministic replies only). Built once per server instance. */
export function chatSynthesizer(env: NodeJS.ProcessEnv = process.env): Synthesizer | null {
  if (!resolvedSynth) {
    const durable = redisLimiterFromEnv(env, {
      name: "synth",
      perUser: { max: intEnv(env.BROKO_AI_SYNTH_USER_MAX, 10), windowSec: 3600 },
      global: { max: intEnv(env.BROKO_AI_SYNTH_GLOBAL_MAX, 100), windowSec: 86_400 },
    });
    resolvedSynth = resolveChatSynthesizer(env, durable ?? undefined);
  }
  return resolvedSynth.synthesizer;
}

// ---- language understanding (typos, Hinglish, follow-ups) -----------------------------------------------------------------------

export interface InterpreterResolution { interpreter: Interpreter | null; status: ChatRouterStatus }

/**
 * The step that works out what a badly typed or Hinglish question MEANT before the Brain acts on it (see chat/interpreter.ts). Same provider, key,
 * on/off switch and fail-closed production rule as the other chat models, with its OWN budget: per user 120 per hour and 2000 per day across
 * everyone by default (BROKO_AI_INTERPRET_USER_MAX / BROKO_AI_INTERPRET_GLOBAL_MAX), because it runs on most questions and each call is small.
 */
export function resolveChatInterpreter(env: NodeJS.ProcessEnv = process.env, durableLimiter?: ModelRateLimiter): InterpreterResolution {
  const cfg = loadAiBrainConfig(env);
  if (cfg.chat !== "llm") return { interpreter: null, status: { enabled: false, reason: "off" } };
  const transport = createModelTransport(cfg, { timeoutMs: 8_000 });
  if (!transport) return { interpreter: null, status: { enabled: false, reason: "no_key" } };
  if (durableLimiter?.durable) return { interpreter: createInterpreter({ transport, limiter: durableLimiter }), status: { enabled: true, limiter: "durable" } };
  if (env.NODE_ENV === "production") return { interpreter: null, status: { enabled: false, reason: "production_needs_durable_limiter" } };
  return { interpreter: createInterpreter({ transport, limiter: createMemoryRateLimiter({ maxCalls: intEnv(env.BROKO_AI_INTERPRET_USER_MAX, 120), windowMs: 3_600_000 }) }), status: { enabled: true, limiter: "in_memory" } };
}

let resolvedInterpreter: InterpreterResolution | undefined;

/** The chat's language-understanding step, or null (messages are used as typed). Built once per server instance. */
export function chatInterpreter(env: NodeJS.ProcessEnv = process.env): Interpreter | null {
  if (!resolvedInterpreter) {
    const durable = redisLimiterFromEnv(env, {
      name: "interpret",
      perUser: { max: intEnv(env.BROKO_AI_INTERPRET_USER_MAX, 120), windowSec: 3600 },
      global: { max: intEnv(env.BROKO_AI_INTERPRET_GLOBAL_MAX, 2000), windowSec: 86_400 },
    });
    resolvedInterpreter = resolveChatInterpreter(env, durable ?? undefined);
  }
  return resolvedInterpreter.interpreter;
}

// ---- Claude tool use through the Tool Registry (Phase 1, behind BROKO_AI_TOOLS) ------------------------------------------------

export interface ToolAgentResolution { toolAgent: ToolAgent | null; status: ChatRouterStatus | { enabled: false; reason: "flag_off" } }

/**
 * The tool-use path (see chat/tool-agent.ts). Needs ALL of: BROKO_AI_TOOLS=1 (default off), BROKO_AI_CHAT=llm, a key, and in production a durable limiter.
 * Same provider, key and model as everything else; its OWN budget: per user 30 per hour and 300 per day across everyone by default
 * (BROKO_AI_TOOLS_USER_MAX / BROKO_AI_TOOLS_GLOBAL_MAX), because one question can take several model turns.
 */
export function resolveChatToolAgent(env: NodeJS.ProcessEnv = process.env, durableLimiter?: ModelRateLimiter): ToolAgentResolution {
  const cfg = loadAiBrainConfig(env);
  if (!cfg.tools) return { toolAgent: null, status: { enabled: false, reason: "flag_off" } };
  if (cfg.chat !== "llm") return { toolAgent: null, status: { enabled: false, reason: "off" } };
  const transport = createToolTransport(cfg, { timeoutMs: 20_000 });
  if (!transport) return { toolAgent: null, status: { enabled: false, reason: "no_key" } };
  if (durableLimiter?.durable) return { toolAgent: createToolAgent({ transport, limiter: durableLimiter }), status: { enabled: true, limiter: "durable" } };
  if (env.NODE_ENV === "production") return { toolAgent: null, status: { enabled: false, reason: "production_needs_durable_limiter" } };
  return { toolAgent: createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: intEnv(env.BROKO_AI_TOOLS_USER_MAX, 30), windowMs: 3_600_000 }) }), status: { enabled: true, limiter: "in_memory" } };
}

/**
 * Migration 0014 may not be applied yet, so the relationship tool is offered to the model only when BROKO_ORG_RELATIONSHIPS=1 (default off).
 * Done here, not in the chat code, because this is the one place that reads the environment.
 */
export function gateRelationshipTool(agent: ToolAgent, env: NodeJS.ProcessEnv = process.env): ToolAgent {
  if (relationshipsEnabled(env)) return agent;
  return { run: (req) => agent.run({ ...req, contracts: req.contracts.filter((c) => c.id !== RELATIONSHIP_TOOL) }) };
}

let resolvedToolAgent: ToolAgentResolution | undefined;

/** The chat's tool-use path, or null (the ordinary Brain path only). Built once per server instance. */
export function chatToolAgent(env: NodeJS.ProcessEnv = process.env): ToolAgent | null {
  if (!resolvedToolAgent) {
    const durable = redisLimiterFromEnv(env, {
      name: "tools",
      perUser: { max: intEnv(env.BROKO_AI_TOOLS_USER_MAX, 30), windowSec: 3600 },
      global: { max: intEnv(env.BROKO_AI_TOOLS_GLOBAL_MAX, 300), windowSec: 86_400 },
    });
    resolvedToolAgent = resolveChatToolAgent(env, durable ?? undefined);
  }
  return resolvedToolAgent.toolAgent ? gateRelationshipTool(resolvedToolAgent.toolAgent, env) : null;
}
