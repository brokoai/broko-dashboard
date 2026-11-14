// Defensive handling of text a person submits as knowledge. Two separate concerns:
//   1. Secrets and sensitive numbers must never be stored. A submission that looks like it contains one is REFUSED (ids only are
//      reported, never the matched text).
//   2. Instruction-like wording is only a tripwire (see ai-brain/injection.ts): it does not refuse, it flags the item for the
//      reviewer, and retrieval marks it as data. Stored text is never interpreted as instructions.

export const SECRET_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "api_key_prefix", re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
  { id: "supabase_key", re: /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "vcs_token", re: /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/ },
  { id: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "credential_assignment", re: /\b(password|passwd|pwd|passphrase|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer)\s*(?:is|=|:)\s*\S{6,}/i },
  { id: "long_hex", re: /\b[A-Fa-f0-9]{40,}\b/ },
  { id: "long_token", re: /\b[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9])/ },
  { id: "us_ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** Pattern ids only; never the matched text. Empty = nothing suspicious found. */
export function secretSignals(...texts: (string | null | undefined)[]): string[] {
  const joined = texts.filter(Boolean).join("\n");
  const ids = SECRET_PATTERNS.filter((p) => p.re.test(joined)).map((p) => p.id);
  if (hasCardNumber(joined)) ids.push("payment_card_number");
  return ids;
}

/** Removes control characters (keeps newlines and tabs), normalizes line endings, trims, and caps runs of blank lines. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Single-line variant for titles and short fields. */
export const cleanLine = (s: string): string => cleanText(s).replace(/\s+/g, " ");
