import {
  URGENCY_TO_PRIORITY, type MessageAnalysis, type NormalizedMessage, type OwnerDecision, type ProcessingPolicy, type RiskFlag,
} from "./schema";
import type { InjectionScan } from "./injection";

const senderDomain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** Model-suggested flags plus the ones the SYSTEM can establish itself. Never fewer than the model's. */
export function assessRisk(args: {
  message: NormalizedMessage;
  analysis: MessageAnalysis;
  injection: InjectionScan;
  policy: ProcessingPolicy;
}): RiskFlag[] {
  const { message, analysis, injection, policy } = args;
  const flags = new Set<RiskFlag>(analysis.risk_flags);
  if (injection.suspected) flags.add("prompt_injection_suspected");
  if (injection.matches.includes("payment_redirect")) { flags.add("possible_phishing"); flags.add("financial"); }
  if (injection.matches.includes("secret_exfiltration")) flags.add("possible_phishing");
  if (message.has_attachments) flags.add("contains_attachment");
  if (analysis.intent === "payment_or_invoice") flags.add("financial");
  if (analysis.intent === "legal_or_compliance") flags.add("legal_or_compliance");
  if (analysis.intent === "complaint" && analysis.urgency !== "low") flags.add("escalation_or_threat");
  // Never treat a sender as verified just because the message names a person or company.
  const verified = policy.verified_sender_domains.map((d) => d.toLowerCase());
  if (!verified.includes(senderDomain(message.sender.email))) flags.add("sender_unverified");
  if (analysis.confidence < 0.6) flags.add("ambiguous_request");
  return [...flags];
}

export type ProposedPriority = "low" | "medium" | "high" | "urgent";

/** Urgency -> task priority. Risk can raise priority, never lower it. */
export function assessPriority(analysis: MessageAnalysis, flags: readonly RiskFlag[]): ProposedPriority {
  let p: ProposedPriority = URGENCY_TO_PRIORITY[analysis.urgency];
  if (flags.includes("escalation_or_threat") && (p === "low" || p === "medium")) p = "high";
  return p;
}

/** A deadline only if the message states one (already grounded) or a configured SLA gives one. */
export function proposeDeadline(analysis: MessageAnalysis, message: NormalizedMessage, policy: ProcessingPolicy): { due_at: string | null; source: "message" | "sla" | null } {
  if (analysis.requested_date) return { due_at: `${analysis.requested_date.date}T00:00:00.000Z`, source: "message" };
  const days = policy.sla_days[analysis.urgency];
  if (days !== undefined) {
    const d = new Date(Date.parse(message.received_at) + days * 86_400_000);
    return { due_at: `${d.toISOString().slice(0, 10)}T00:00:00.000Z`, source: "sla" };
  }
  return { due_at: null, source: null };
}

export type Decision = { status: "NO_ACTION" | "REVIEW_REQUIRED" | "APPROVED"; reasons: string[] };

/**
 * The explicit, configurable policy. Default (`auto_create: "never"`): every task proposal needs a
 * human. "low_risk": a task may be created without review ONLY if there is nothing at all to flag.
 * The model has no input into this decision beyond the validated fields it is based on.
 */
export function decide(args: {
  analysis: MessageAnalysis;
  flags: readonly RiskFlag[];
  owner: OwnerDecision;
  policy: ProcessingPolicy;
}): Decision {
  const { analysis: a, flags, owner, policy } = args;
  const dangerous = flags.includes("prompt_injection_suspected") || flags.includes("possible_phishing");

  if (!a.requires_action || a.intent === "spam_or_irrelevant") {
    return dangerous
      ? { status: "REVIEW_REQUIRED", reasons: flags.filter((f) => f === "prompt_injection_suspected" || f === "possible_phishing").map((f) => `risk:${f}`) }
      : { status: "NO_ACTION", reasons: [a.intent === "spam_or_irrelevant" ? "spam_or_irrelevant" : "no_action_required"] };
  }

  const reasons: string[] = [];
  if (a.confidence < policy.min_confidence) reasons.push("low_confidence");
  if (policy.always_review_intents.includes(a.intent)) reasons.push(`sensitive_intent:${a.intent}`);
  for (const f of flags) reasons.push(`risk:${f}`);
  if (a.missing_information.length) reasons.push("missing_information");
  if (!owner.user_id) reasons.push("no_owner");
  if (!a.proposed_task) reasons.push("no_task_proposal");
  if (policy.auto_create === "never") reasons.push("policy_requires_approval");
  return { status: reasons.length ? "REVIEW_REQUIRED" : "APPROVED", reasons };
}
