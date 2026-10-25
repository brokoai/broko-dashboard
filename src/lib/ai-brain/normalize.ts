import { createHash } from "node:crypto";
import { LIMITS, NormalizedMessageSchema, type NormalizedMessage, type RawEmail } from "./schema";

/** Thrown for input we refuse to process. Messages never include message content. */
export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

export interface NormalizeOptions {
  /** Store recipient addresses? Off by default (data minimisation). */
  includeRecipients?: boolean;
  now?: Date;
}

export interface NormalizeSignals {
  /** True if visually hidden HTML text (display:none, font-size:0 ...) was removed. */
  hidden_text_removed: boolean;
  invisible_chars_removed: number;
  /** Hidden text (capped) so the injection scanner can still see what a human would not. Never stored. */
  hidden_text: string;
}

// C0 controls (except tab/newline/CR), DEL, zero-width and bidirectional-override characters.
// These are used to hide or reorder text, so they never reach the model.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Very small, dependency-free HTML -> text. Not a sanitiser: its output is plain text only. */
export function htmlToText(html: string): { text: string; hidden: string } {
  let hidden = "";
  let s = html.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, " ");
  // Elements styled to be invisible: remove, but remember the text for the injection scanner.
  s = s.replace(
    /<([a-z0-9]+)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem)?\s*(?:;|["'])|opacity\s*:\s*0\s*(?:;|["']))[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _tag: string, inner: string) => {
      hidden += " " + inner.replace(/<[^>]+>/g, " ");
      return " ";
    },
  );
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  return { text: decodeEntities(s), hidden: decodeEntities(hidden).slice(0, 2000) };
}

const QUOTE_CUTS: RegExp[] = [
  /^On .{5,200} wrote:\s*$/i,
  /^-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
];

/** Drops the quoted earlier thread (old content must not be re-processed or re-read as instructions). */
export function removeQuotedText(text: string): { text: string; removed: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (QUOTE_CUTS.some((re) => re.test(line.trim())) || (/^From:\s+\S/i.test(line) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s/i.test(l)))) {
      removed = true;
      break;
    }
    if (/^\s*>/.test(line)) { removed = true; continue; }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

const clean = (s: string | null | undefined): { text: string; invisible: number } => {
  const input = s ?? "";
  const stripped = input.replace(INVISIBLE, "");
  return { text: stripped.normalize("NFKC"), invisible: input.length - stripped.length };
};

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Canonical, case-insensitive RFC 5322 Message-ID (without angle brackets). */
export const canonicalMessageId = (id: string | null | undefined): string | null => {
  const v = (id ?? "").replace(INVISIBLE, "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return v ? v.slice(0, LIMITS.messageId) : null;
};

/**
 * Provider-neutral email -> NormalizedMessage. Pure, deterministic and side-effect free.
 * Throws NormalizationError for input that cannot be safely represented.
 */
export function normalizeEmail(raw: RawEmail, opts: NormalizeOptions = {}): { message: NormalizedMessage; signals: NormalizeSignals } {
  const now = opts.now ?? new Date();
  const received = new Date(raw.receivedAt);
  if (Number.isNaN(received.getTime())) throw new NormalizationError("received_at is not a valid date");
  if (received.getTime() > now.getTime() + 24 * 3_600_000) throw new NormalizationError("received_at is in the future");

  let invisible = 0;
  const take = (s: string | null | undefined) => { const c = clean(s); invisible += c.invisible; return c.text; };

  let bodyRaw: string, hidden = "";
  if (raw.bodyText && raw.bodyText.trim()) bodyRaw = take(raw.bodyText);
  // Entities such as &#8203; decode to invisible characters AFTER the first strip, so clean the decoded text again.
  else if (raw.bodyHtml) { const h = htmlToText(take(raw.bodyHtml)); bodyRaw = take(h.text); hidden = take(h.hidden); }
  else bodyRaw = "";

  const unquoted = removeQuotedText(bodyRaw);
  let body = unquoted.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = body.length > LIMITS.body;
  if (truncated) body = body.slice(0, LIMITS.body);

  const attachmentNames = (raw.attachmentNames ?? []).slice(0, LIMITS.attachmentNames).map((n) => oneLine(take(n), LIMITS.attachmentName)).filter(Boolean);
  const recipients = opts.includeRecipients
    ? (raw.to ?? []).map((a) => a.trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)).slice(0, LIMITS.recipients)
    : [];

  const subject = oneLine(take(raw.subject), LIMITS.subject);
  const parsed = NormalizedMessageSchema.safeParse({
    provider: raw.provider,
    source_message_id: take(raw.id).trim(),
    internet_message_id: canonicalMessageId(raw.internetMessageId),
    thread_id: raw.threadId ? take(raw.threadId).trim().slice(0, LIMITS.messageId) : null,
    mailbox_ref: take(raw.mailboxRef).trim(),
    received_at: received.toISOString(),
    sender: { name: raw.from.name ? oneLine(take(raw.from.name).replace(/["<>]/g, ""), LIMITS.senderName) || null : null, email: take(raw.from.address).trim().toLowerCase() },
    recipients,
    subject,
    body_text: body,
    body_truncated: truncated,
    quoted_text_removed: unquoted.removed,
    has_attachments: Boolean(raw.hasAttachments) || attachmentNames.length > 0,
    attachment_names: attachmentNames,
    content_hash: createHash("sha256").update(`${subject}\n${body}`, "utf8").digest("hex"),
  });
  if (!parsed.success) {
    // Field paths only: never echo the offending value (it may be personal data or an attack string).
    throw new NormalizationError(`invalid message fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}`);
  }
  return { message: parsed.data, signals: { hidden_text_removed: hidden.length > 0, invisible_chars_removed: invisible, hidden_text: hidden } };
}

/**
 * Idempotency key. Prefers the RFC 5322 Message-ID so the same email delivered to two monitored
 * mailboxes (or seen through two providers) is processed once; falls back to provider + mailbox + id.
 */
export function dedupeKey(m: Pick<NormalizedMessage, "provider" | "source_message_id" | "internet_message_id" | "mailbox_ref">, tenant = "broko"): string {
  return m.internet_message_id
    ? `${tenant}|mid|${m.internet_message_id}`
    : `${tenant}|${m.provider}|${m.mailbox_ref}|${m.source_message_id}`;
}
