import type { MessageAnalysis, MissingInfo, NormalizedMessage } from "./schema";

/**
 * "The AI must not invent missing information."
 *
 * The model's claims are only kept if the message itself supports them. Anything unsupported is
 * dropped to null (and reported as missing) rather than trusted. Pure and deterministic.
 */
export interface GroundingResult {
  analysis: MessageAnalysis;
  /** Human-readable, content-free notes about what was dropped or downgraded. */
  notes: string[];
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D+/g, "");

const isRealDate = (iso: string): boolean => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export function groundAnalysis(msg: NormalizedMessage, input: MessageAnalysis): GroundingResult {
  const a: MessageAnalysis = structuredClone(input);
  const notes: string[] = [];
  const haystack = squash(`${msg.subject}\n${msg.body_text}`);
  const phoneHay = digits(`${msg.subject} ${msg.body_text}`);
  const missing = new Set<MissingInfo>(a.missing_information);

  // contact.email: the sender's own address, or one that appears in the message.
  if (a.contact.email && a.contact.email.toLowerCase() !== msg.sender.email && !haystack.includes(a.contact.email.toLowerCase())) {
    notes.push("dropped contact.email: not present in the message");
    a.contact.email = null;
  }
  // contact.phone: at least 7 digits, all present (in order) in the message.
  if (a.contact.phone) {
    const d = digits(a.contact.phone);
    if (d.length < 7 || !phoneHay.includes(d)) {
      notes.push("dropped contact.phone: not present in the message");
      a.contact.phone = null;
    }
  }
  if (!a.contact.phone && (a.intent === "viewing_request" || a.intent === "property_inquiry" || a.intent === "scheduling")) missing.add("contact_phone");
  // contact.name: from the sender's display name or the message text.
  if (a.contact.name && !squash(`${msg.sender.name ?? ""} ${msg.body_text} ${msg.subject}`).includes(squash(a.contact.name))) {
    notes.push("dropped contact.name: not present in the message");
    a.contact.name = null;
  }
  if (!a.contact.name && !msg.sender.name) missing.add("contact_name");

  if (a.property_reference && !haystack.includes(squash(a.property_reference))) {
    notes.push("dropped property_reference: not present in the message");
    a.property_reference = null;
  }
  if (!a.property_reference && (a.intent === "viewing_request" || a.intent === "property_inquiry" || a.intent === "offer_or_negotiation")) missing.add("property_reference");

  if (a.requested_date) {
    const { date, evidence } = a.requested_date;
    const received = Date.parse(msg.received_at);
    const when = Date.parse(`${date}T00:00:00.000Z`);
    const oneDay = 86_400_000;
    if (!isRealDate(date)) { notes.push("dropped requested_date: not a real calendar date"); a.requested_date = null; }
    else if (!haystack.includes(squash(evidence))) { notes.push("dropped requested_date: evidence not found in the message"); a.requested_date = null; }
    else if (when < received - oneDay) { notes.push("dropped requested_date: it is in the past"); a.requested_date = null; }
    else if (when > received + 800 * oneDay) { notes.push("dropped requested_date: implausibly far in the future"); a.requested_date = null; }
  }
  if (!a.requested_date && (a.intent === "viewing_request" || a.intent === "scheduling")) missing.add("preferred_date");

  // Urgency above "normal" needs words from the message to justify it.
  if ((a.urgency === "high" || a.urgency === "urgent") && !(a.urgency_evidence && haystack.includes(squash(a.urgency_evidence)))) {
    notes.push(`downgraded urgency ${a.urgency} -> normal: no supporting words in the message`);
    a.urgency = "normal";
    a.urgency_evidence = null;
  }
  if (a.urgency === "low" || a.urgency === "normal") a.urgency_evidence = a.urgency_evidence && haystack.includes(squash(a.urgency_evidence)) ? a.urgency_evidence : null;

  if (a.requires_action && !a.requested_action) missing.add("requested_action");

  a.missing_information = [...missing];
  return { analysis: a, notes };
}
