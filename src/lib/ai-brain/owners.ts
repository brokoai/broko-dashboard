import { z } from "zod";
import { OwnerRuleSchema, URGENCIES, type MessageAnalysis, type OwnerDecision, type OwnerRule } from "./schema";

/** Validates configured rules. Throws with field paths only (never the rule contents). */
export function parseOwnerRules(input: unknown): OwnerRule[] {
  const parsed = z.array(OwnerRuleSchema).max(200).safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid owner rules: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}`);
  }
  const ids = parsed.data.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("invalid owner rules: duplicate rule ids");
  return parsed.data;
}

const urgencyRank = (u: MessageAnalysis["urgency"]) => URGENCIES.indexOf(u);

function matches(rule: OwnerRule, a: MessageAnalysis): boolean {
  const w = rule.when;
  if (w.intents && !w.intents.includes(a.intent)) return false;
  if (w.min_urgency && urgencyRank(a.urgency) < urgencyRank(w.min_urgency)) return false;
  if (w.property_prefix) {
    // Only a grounded property reference counts: the sender can't invent one the message lacks.
    if (!a.property_reference || !a.property_reference.toLowerCase().startsWith(w.property_prefix.toLowerCase())) return false;
  }
  return true;
}

/**
 * Deterministic owner resolution. The model never chooses an owner. First matching rule wins
 * (priority desc, then id). The chosen owner must be an assignable person; otherwise the next
 * rule is tried and, if none works, there is NO owner and a human must decide.
 */
export function resolveOwner(args: { analysis: MessageAnalysis; rules: readonly OwnerRule[]; assignable: ReadonlySet<string> }): OwnerDecision {
  const ordered = [...args.rules].sort((x, y) => y.priority - x.priority || x.id.localeCompare(y.id));
  let skipped: string | null = null;
  for (const rule of ordered) {
    if (!matches(rule, args.analysis)) continue;
    if (!args.assignable.has(rule.owner_id)) {
      skipped ??= `rule "${rule.id}" matched but its owner is not an assignable person`;
      continue;
    }
    return { user_id: rule.owner_id, rule_id: rule.id, reason: `matched rule "${rule.id}"` };
  }
  return { user_id: null, rule_id: null, reason: skipped ?? (args.rules.length ? "no owner rule matched" : "no owner rules configured") };
}
