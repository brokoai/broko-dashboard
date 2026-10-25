import { createModelTransport } from "./model-transport";
import { ClassificationError, LlmClassifier, RuleBasedClassifier, classifyWithInfo, type Classifier, type LlmTransport } from "./classifier";
import type { AiBrainConfig } from "./config";
import { MessageAnalysisSchema, type ClassifierInfo, type NormalizedMessage } from "./schema";

/**
 * Wraps a model classifier with the deterministic rule-based one. If the model is unreachable, or
 * returns something that is not valid JSON or does not match the schema, the message is classified by
 * the rules instead and the record says so (`fallback_reason`). The result still goes through the same
 * strict validation, grounding, risk assessment, owner rules and human approval as any other.
 * After an outage the model is skipped for `cooldownMs` so one failing API cannot stall every request.
 */
export class FallbackClassifier implements Classifier {
  readonly name: string;
  readonly mode = "llm" as const;
  private downUntil = 0;

  constructor(
    private readonly primary: Classifier,
    private readonly fallback: Classifier = new RuleBasedClassifier(),
    private readonly opts: { cooldownMs?: number; now?: () => number } = {},
  ) {
    this.name = `${primary.name}+rules-fallback`;
  }

  async analyze(msg: NormalizedMessage): Promise<unknown> {
    return (await this.analyzeDetailed(msg)).analysis;
  }

  async analyzeDetailed(msg: NormalizedMessage): Promise<{ analysis: unknown; info: ClassifierInfo }> {
    const now = this.opts.now ?? Date.now;
    const viaRules = async (reason: NonNullable<ClassifierInfo["fallback_reason"]>) => ({
      analysis: (await classifyWithInfo(this.fallback, msg)).analysis,
      info: { name: this.fallback.name, mode: "rules" as const, fallback_reason: reason },
    });
    if (now() < this.downUntil) return viaRules("model_unavailable");
    try {
      const analysis = await this.primary.analyze(msg);
      if (!MessageAnalysisSchema.safeParse(analysis).success) return viaRules("model_output_invalid");
      return { analysis, info: { name: this.primary.name, mode: "llm", fallback_reason: null } };
    } catch (e) {
      if (e instanceof ClassificationError) return viaRules("model_output_invalid");
      // LlmError or anything else: treat as an outage. Details are deliberately dropped here.
      this.downUntil = now() + (this.opts.cooldownMs ?? 60_000);
      return viaRules("model_unavailable");
    }
  }
}

/** Remembers results per message content so repeated page views do not repeat paid model calls. Bounded. */
export class CachingClassifier implements Classifier {
  readonly name: string;
  readonly mode: Classifier["mode"];
  private readonly entries = new Map<string, { at: number; value: { analysis: unknown; info: ClassifierInfo } }>();

  constructor(
    private readonly inner: Classifier,
    private readonly opts: { max?: number; ttlMs?: number; fallbackTtlMs?: number; now?: () => number } = {},
  ) {
    this.name = inner.name;
    this.mode = inner.mode;
  }

  async analyze(msg: NormalizedMessage): Promise<unknown> {
    return (await this.analyzeDetailed(msg)).analysis;
  }

  async analyzeDetailed(msg: NormalizedMessage): Promise<{ analysis: unknown; info: ClassifierInfo }> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.entries.get(msg.content_hash);
    if (hit) {
      const ttl = hit.value.info.fallback_reason ? (this.opts.fallbackTtlMs ?? 60_000) : (this.opts.ttlMs ?? 10 * 60_000);
      if (now - hit.at < ttl) return structuredClone(hit.value);
      this.entries.delete(msg.content_hash);
    }
    const value = await classifyWithInfo(this.inner, msg);
    this.entries.set(msg.content_hash, { at: now, value: structuredClone(value) });
    while (this.entries.size > (this.opts.max ?? 64)) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }
}

export interface ClassifierSelection {
  classifier: Classifier;
  mode: "rules" | "llm";
  model: string | null;
  /** Shown to the user when the requested mode could not be honoured. Never contains secrets. */
  note: string | null;
  /**
   * Present in model mode only. A background worker applies its own timeout/retry/fallback policy, so it needs the raw
   * model classifier (cached on success) and the rules separately. Without it, `classifier` is used as is.
   */
  llm?: { primary: Classifier; fallback: Classifier };
}

export const rulesSelection = (note: string | null = null): ClassifierSelection => ({ classifier: new RuleBasedClassifier(), mode: "rules", model: null, note });

/**
 * Chooses the classifier from server-side configuration. Rule-based is the default. "llm" needs both
 * BROKO_AI_CLASSIFIER=llm and ANTHROPIC_API_KEY; without a key it falls back, and says so.
 */
export function selectClassifier(cfg: AiBrainConfig, deps: { transport?: LlmTransport; now?: () => number } = {}): ClassifierSelection {
  if (cfg.classifier !== "llm") return rulesSelection();
  const transport = deps.transport ?? createModelTransport(cfg, { timeoutMs: 20_000 });
  if (!transport) return rulesSelection("The model classifier was requested but no API key is configured, so the rule-based classifier is being used.");
  const model = new LlmClassifier(transport, `llm:${cfg.llm.model}`);
  const rules = new RuleBasedClassifier();
  const classifier = new CachingClassifier(new FallbackClassifier(model, rules, { now: deps.now }), { now: deps.now });
  return { classifier, mode: "llm", model: cfg.llm.model, note: null, llm: { primary: new CachingClassifier(model, { now: deps.now }), fallback: rules } };
}
