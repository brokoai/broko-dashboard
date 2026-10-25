/**
 * Prompt-injection SIGNALS. This is a tripwire, not a security boundary.
 *
 * The real protection is structural: the model gets no tools, its output is a strict schema that
 * cannot carry owners/status/approvals, grounding drops unsupported claims, owners come from
 * configuration, and a human approves task creation. A match here simply forces human review.
 */
const PATTERNS: { id: string; re: RegExp }[] = [
  { id: "ignore_previous_instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|guidelines?|policy|policies)\b/i },
  { id: "role_hijack", re: /\b(you are now|from now on you|act as (an?|the)|pretend (to be|you are)|new (instructions?|role|persona)|developer mode|jailbreak)\b/i },
  { id: "system_prompt_probe", re: /\b(system prompt|developer message|hidden (instructions?|prompt)|your (instructions?|prompt|configuration))\b/i },
  { id: "secret_exfiltration", re: /\b(reveal|show|print|send|share|leak|output|email me|forward)\b[^.\n]{0,50}\b(api[- ]?keys?|secrets?|passwords?|tokens?|credentials?|private keys?|environment variables?|\.env)\b/i },
  { id: "approval_bypass", re: /\b(skip|bypass|disable|turn off|without)\b[^.\n]{0,30}\b(approval|review|verification|checks?|safeguards?)\b|\bauto[- ]?approve\b|\bdo not (flag|escalate|review)\b/i },
  { id: "action_command", re: /\b(execute|run)\b[^.\n]{0,30}\b(this|the following)?\s*(command|script|code|query)\b|\b(rm -rf|curl\s+https?:|powershell|wget\s+https?:|drop table|<script)\b/i },
  { id: "config_change", re: /\b(change|update|set|modify)\b[^.\n]{0,30}\b(owner rules?|assignment rules?|policy|configuration|permissions?|admin(istrator)?s?)\b/i },
  { id: "delimiter_forgery", re: /<\/?\s*(email|message|system|assistant|instructions?)\b[^>]*>|```\s*(system|assistant)|^\s*(system|assistant)\s*:/im },
  { id: "markdown_exfil_image", re: /!\[[^\]]*\]\(https?:\/\/[^)\s]+\?[^)\s]*\)/i },
  { id: "payment_redirect", re: /\b(change[ds]?|new|updated)\b[^.\n]{0,30}\b(bank|iban|account number|routing|wire)\b[^.\n]{0,30}\b(details?|instructions?|account)\b|\b(bank|iban|wire|payment)\s+(details?|instructions?)\b[^.\n]{0,30}\b(chang(e|ed|ing)|updated|new)\b|\buse the new (bank |iban |wire )?(account|iban)\b/i },
];

export interface InjectionScan {
  suspected: boolean;
  /** Pattern ids only; never the matched text. */
  matches: string[];
}

export function scanForInjection(...texts: (string | null | undefined)[]): InjectionScan {
  const joined = texts.filter(Boolean).join("\n");
  const matches = PATTERNS.filter((p) => p.re.test(joined)).map((p) => p.id);
  return { suspected: matches.length > 0, matches };
}
