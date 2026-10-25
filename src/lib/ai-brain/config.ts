import { DEFAULT_POLICY, ProcessingPolicySchema, type OwnerRule, type ProcessingPolicy } from "./schema";
import { parseOwnerRules } from "./owners";

export interface AiBrainConfig {
  /** Requested mode. "llm" still falls back to rules (explicitly) when no key is configured. Default: rules. */
  classifier: "rules" | "llm";
  /** Requested chat routing. "llm" still needs ANTHROPIC_API_KEY; otherwise chat uses deterministic routing. Default: rules. */
  chat: "rules" | "llm";
  llm: { configured: boolean; model: string };
  policy: ProcessingPolicy;
  ownerRules: OwnerRule[];
  /** Content-free descriptions of anything that was invalid and fell back to the strictest default. */
  problems: string[];
  /** Non-enumerable: never appears in JSON.stringify, console.log or spreads. */
  readonly apiKey?: string;
}

export const DEFAULT_MODEL = "claude-haiku-5-5";

function parseJson(raw: string | undefined, name: string, problems: string[]): unknown | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    problems.push(`${name} is not valid JSON; ignored`);
    return undefined;
  }
}

/**
 * Reads configuration from environment variables (server-side only; never NEXT_PUBLIC_).
 * Invalid values never loosen behaviour: a bad policy falls back to the strictest default
 * (human approval for everything) and bad owner rules to none (so every item needs review).
 * Error text never echoes configured values.
 */
export function loadAiBrainConfig(env: Record<string, string | undefined>): AiBrainConfig {
  const problems: string[] = [];

  let policy: ProcessingPolicy = { ...DEFAULT_POLICY };
  const rawPolicy = parseJson(env.BROKO_AI_POLICY, "BROKO_AI_POLICY", problems);
  if (rawPolicy !== undefined) {
    const parsed = ProcessingPolicySchema.partial().safeParse(rawPolicy);
    if (parsed.success) policy = { ...DEFAULT_POLICY, ...parsed.data, sla_days: { ...DEFAULT_POLICY.sla_days, ...(parsed.data.sla_days ?? {}) } };
    else problems.push(`BROKO_AI_POLICY is invalid (${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}); using the strictest default`);
  }

  let ownerRules: OwnerRule[] = [];
  const rawRules = parseJson(env.BROKO_AI_OWNER_RULES, "BROKO_AI_OWNER_RULES", problems);
  if (rawRules !== undefined) {
    try {
      ownerRules = parseOwnerRules(rawRules);
    } catch (e) {
      problems.push(`${(e as Error).message}; no owner rules loaded`);
    }
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const requested = env.BROKO_AI_CLASSIFIER?.trim().toLowerCase();
  let classifier: AiBrainConfig["classifier"] = "rules";
  if (requested === "llm") classifier = "llm";
  else if (requested && requested !== "rules") problems.push("BROKO_AI_CLASSIFIER is invalid; using the rule-based classifier");
  const chatRequested = env.BROKO_AI_CHAT?.trim().toLowerCase();
  if (chatRequested && chatRequested !== "rules" && chatRequested !== "llm") problems.push("BROKO_AI_CHAT is invalid; chat uses deterministic routing");
  const chat: AiBrainConfig["chat"] = chatRequested === "llm" ? "llm" : "rules";
  const cfg: AiBrainConfig = { classifier, chat, llm: { configured: Boolean(apiKey), model: env.BROKO_AI_MODEL?.trim() || DEFAULT_MODEL }, policy, ownerRules, problems };
  Object.defineProperty(cfg, "apiKey", { value: apiKey, enumerable: false });
  return cfg;
}
