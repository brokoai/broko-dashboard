import { anthropicTransport, type LlmTransport } from "./classifier";
import type { AiBrainConfig } from "./config";

/**
 * The ONE place a model transport is built from configuration. The email classifier and the chat router both call this, so
 * there is a single provider, a single key (ANTHROPIC_API_KEY) and a single model setting (BROKO_AI_MODEL).
 * Returns null when no key is configured. The key is read from the config object and never logged or returned.
 */
export function createModelTransport(cfg: AiBrainConfig, opts: { timeoutMs?: number } = {}): LlmTransport | null {
  const key = cfg.apiKey;
  if (!key) return null;
  return anthropicTransport({ apiKey: key, model: cfg.llm.model, timeoutMs: opts.timeoutMs });
}
