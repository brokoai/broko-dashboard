import type { LlmTransport } from "../classifier";
import { createMemoryRateLimiter, type ModelRateLimiter } from "./model-router";

/**
 * The model call used to ANALYSE retrieved content (as opposed to the router, which only picks a question). It is deliberately a
 * different object with its own budget: a meeting analysis sends thousands of tokens, so it must not share the router's limits.
 *
 * It holds no data, no user identity and no tool: the caller passes a prompt that the Brain built from records it already retrieved and
 * authorized. It never throws. Any failure, including an exhausted budget, is a fixed reason the caller answers with a deterministic reply.
 */

export type SynthesisFailure = "budget" | "unavailable";
export type SynthesisResult = { ok: true; text: string } | { ok: false; reason: SynthesisFailure };

export interface Synthesizer {
  run(userId: string, req: { system: string; user: string; maxTokens: number }): Promise<SynthesisResult>;
}

export interface SynthesizerOptions {
  transport: LlmTransport;
  limiter?: ModelRateLimiter;
  /** After a transport failure the model is skipped for this long, so one outage cannot slow every question. Default 60 s. */
  cooldownMs?: number;
  now?: () => number;
}

export function createSynthesizer(opts: SynthesizerOptions): Synthesizer {
  const now = opts.now ?? Date.now;
  const cooldown = opts.cooldownMs ?? 60_000;
  const limiter = opts.limiter ?? createMemoryRateLimiter({ maxCalls: 10, windowMs: 3_600_000 });
  let downUntil = 0;
  return {
    async run(userId, req) {
      if (now() < downUntil) return { ok: false, reason: "unavailable" };
      let allowed = false;
      try { allowed = await limiter.take(userId); } catch { allowed = false; } // fail closed
      if (!allowed) return { ok: false, reason: "budget" };
      try {
        const text = await opts.transport({ system: req.system, user: req.user, maxTokens: req.maxTokens });
        return { ok: true, text };
      } catch {
        downUntil = now() + cooldown; // details deliberately dropped: an error can echo the prompt
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
