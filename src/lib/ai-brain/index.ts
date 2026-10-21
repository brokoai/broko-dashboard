// Broko AI Brain: Communication Agent (Phase 1 core). See docs/ai-brain/ARCHITECTURE.md.
export * from "./schema";
export { NormalizationError, canonicalMessageId, dedupeKey, htmlToText, normalizeEmail, removeQuotedText } from "./normalize";
export { scanForInjection } from "./injection";
export { groundAnalysis } from "./grounding";
export { parseOwnerRules, resolveOwner } from "./owners";
export { assessPriority, assessRisk, decide, proposeDeadline } from "./policy";
export {
  ClassificationError, LlmClassifier, LlmError, RuleBasedClassifier, SYSTEM_PROMPT, anthropicTransport, buildUserPrompt, extractJson,
  type Classifier, type LlmRequest, type LlmTransport,
} from "./classifier";
export { buildTaskInput, sourceRef } from "./task-mapping";
export { loadAiBrainConfig, DEFAULT_MODEL, type AiBrainConfig } from "./config";
export type { AuditEvent, AuditSink, EmailProvider, Notifier, ProcessingStore, ProviderConnection, TaskActor, TaskSink, TaskSinkContext } from "./ports";
export { TaskSinkDenied } from "./ports";
export { InMemoryAuditSink, InMemoryProcessingStore, SyntheticEmailProvider, UnconfiguredEmailProvider, UnconfiguredNotifier } from "./memory";
export { ingestFromProvider, processMessage, reviewMessage, type IngestSummary, type PipelineDeps, type PipelineResult, type ReviewDecision, type ReviewResult } from "./pipeline";
export { DUPLICATE_OF_VIEWING, SYNTHETIC_EMAILS, SYNTHETIC_NOW, longEmail } from "./fixtures";
