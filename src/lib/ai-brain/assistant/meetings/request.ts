import { dateMinusDays, isValidTimeZone, localParts, TZ_ABBREVIATIONS, validDate } from "./datetime";
import type { ChatFocus } from "../../chat/types";

/**
 * Understands a natural-language meeting question. Deterministic: no model is involved, so the dates and times it extracts can be
 * tested exactly. It never guesses a year: a date without a year stays a month and day, and the caller asks if more than one year
 * matches. An ambiguous date (3/4) is turned into a question, not an assumption.
 */

export type MeetingOutput = "summary" | "decisions" | "action_items" | "content" | "all";
export type MeetingIntent = "meeting_summary" | "meeting_decisions" | "meeting_action_items" | "meeting_content" | "meeting_all";
export interface MeetingDate { month: number; day: number; year?: number }

export interface MeetingRequest {
  intent: MeetingIntent;
  output: MeetingOutput;
  date?: MeetingDate;
  time?: { hour: number; minute: number };
  /** The zone the date and time are read in, and whether the user named it (otherwise it is the configured default). */
  tz: string;
  tz_label: string;
  tz_explicit: boolean;
  keywords: string[];
  /** A title the user quoted. Matched literally; never parsed for dates or words. */
  exact_title?: string;
  /** "last / latest / most recent": the newest matching meeting that has already happened. */
  latest: boolean;
  /** Set when the date or time cannot be read safely. The caller asks this instead of searching. */
  clarify?: string;
  /** A date range in the question's zone, as local YYYY-MM-DD ("last week", "this week"). */
  window?: { from: string; to: string; label: "last week" | "this week" };
  /** Follow-up targets, only ever set when the conversation already has a meeting in focus: that meeting, the one before it, or the one after it. */
  target?: "focus" | "previous" | "next";
  /** A question about a topic across several meetings ("what did we agree about X", "was this discussed last week"). */
  topic?: { terms: string[]; when: "any" | "window" | "later"; asks: "agreed" | "discussed"; /** The terms came from what the meeting in focus was about, not from the user's words. */ derived: boolean };
  /** The user wants it short ("a short executive summary"). */
  brief: boolean;
  /** A narrower question about the action items: who owns them, or what is still open. */
  narrow?: "owners" | "pending";
}

const MEETING_WORD = /\bmeetings?\b/i;
const KIND = {
  decisions: /\b(decid\w*|decisions?|agree\w*|resolved|conclusions?)\b/i,
  action: /\b(action items?|action points?|to-?dos?|tasks?|follow-?ups?|assigned|assignees?|next steps|owners?|deadlines?)\b/i,
  // "sumary", "summoray", "summarry" and similar typos are common enough to read as a summary request.
  summary: /\b(summari[sz]e\w*|summary|sum+[oa]?r\w*|discuss\w*|overview|recap|what happened|what was covered|minutes|key points)\b/i,
  content: /\b(transcript|full (?:text|content|notes)|meeting (?:notes|content)|show (?:me )?the (?:notes|content))\b/i,
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthName = (n: number): string => (MONTHS[n - 1] ?? "?").replace(/^./, (c) => c.toUpperCase());
const monthNumber = (s: string): number => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";

const STOP = new Set((
  "a an the and or of to in on at for from with about by is are was were be been do does did what whats who whom which when how why show me tell give find get search look " +
  "please can could would should i we you our my your us it its this that these those there here any all some more most also just only then than " +
  "summarize summarise summary summaries discuss discussed discussion decide decided decision decisions agree agreed agreement action actions item items point points " +
  "pending task tasks follow followup followups assigned important key extract list meeting meetings notion page pages note notes minutes call overview recap " +
  "last latest recent most previous yesterday today tomorrow day before week month year ago morning afternoon evening noon midnight next steps owner owners deadline deadlines " +
  "team teams client clients " +
  "came come comes coming out up into during regarding concerning happen happened happens covered cover covers talked talk talking said say says " +
  "mentioned raised result results outcome outcomes get got going go went needs need needed want wanted pull pulled fetch retrieve bring load check share send owns own owned given gave giving responsible accountable handling handled still anything something whose few"
).split(/\s+/));
// Note: "team" and "client" are removed above only as noise words; a title keyword like "client" is restored below when the user wrote "client meeting".
const KEEP_IF_ADJACENT_TO_MEETING = new Set(["client", "clients", "team", "marketing", "sales", "product", "engineering", "design", "board", "partner"]);

/** Everything between double quotes (straight or curly). Quoted text is a literal title, not a question. */
function takeQuoted(message: string): { rest: string; title?: string } {
  const m = /["“]([^"”\n]{2,120})["”]/.exec(message);
  if (!m) return { rest: message };
  return { rest: message.slice(0, m.index) + " " + message.slice(m.index + m[0].length), title: m[1].trim() };
}

export interface ParseOptions { now: Date; tz: string; focus?: ChatFocus }

// ---- follow-ups: only understood when a meeting is already the topic of the conversation --------------------------------------
const NOT_ABOUT_MEETINGS = /\b(my|mine|tasks?|notifications?|inbox|integrations?|overdue|activity|connected|sources?)\b/i;
const FOLLOW = {
  owners: /\b(responsible|owns?|owner|owners|assigned|assignees?|accountable)\b/i,
  pending: /\b(pending|remain\w*|still (?:open|outstanding|to do|unresolved)|left to do|outstanding|unresolved|open items|open questions|not (?:done|finished|completed))\b/i,
  decisions: /\b(decid\w*|decisions?|agree\w*|resolved|concluded|conclusions?)\b/i,
  summary: /\b(summar\w*|sum+[oa]?r\w*|overview|recap|tl;?dr|executive|what (?:happened|was covered|was discussed)|key points|in a nutshell)\b/i,
};
const BRIEF = /\b(short|brief|quick|tl;?dr|executive|one[- ]liner|one[- ]line|in a nutshell|in brief|in a few (?:words|lines))\b/i;
const PREVIOUS = /\b(previous|prior|preceding|earlier|before (?:that|this|it)|one before|last one before)\b/i;
const NEXT = /\b(next|following|after (?:that|this)|later one)\b/i;
const THIS_MEETING = /\b(that|this|the same|the above)\s+(meeting|one|call)\b/i;
const DISCUSSED = /\b(discuss\w*|came up|come up|mention\w*|raised|covered|talked|brought up|talk(?:ing)? about)\b/i;
const AGREED = /\b(agree\w*|decid\w*|decision|conclude\w*|resolved|settled)\b/i;
const CHANGED = /\b(chang\w*|still (?:valid|stand|hold|apply)|updated|revis\w*|reversed|overturn\w*|different now)\b/i;
// "what we discussed last Thursday": no word "meeting", but a past-tense talk verb plus a date is plainly a question about a meeting.
const PAST_TALK = /\b(?:we|you|they|everyone|the team)\s+(?:discussed|talked(?: about)?|decided|agreed|covered|went over)\b|\bwhat\s+(?:was|were)\s+(?:discussed|decided|agreed|covered|said)\b|\bwhat\s+did\s+(?:we|they|you)\s+(?:discuss|decide|agree|cover|talk about|say)\b|\bwhat\s+(?:decisions?|action items?)\s+(?:was|were|came)\s+(?:made|taken|out)\b/i;
const DATEISH = /\b(yesterday|day before yesterday|(?:last\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last week|this week|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/i;
// "can you pull the Notion meeting?": asking for a meeting with no kind named means its summary, but only when Notion is named or the verb is explicit.
const FETCH_ASK = /\b(?:pull|fetch|retrieve|bring up|get|show|give|open|read|see|find)\b/i;
const ABOUT = /\b(?:about|on|regarding|around|concerning)\s+(?:the\s+|our\s+|a\s+)?(.{2,60}?)(?:[?.!]|$)/i;

/** The Monday-to-Sunday week that contains today, or the one before it, as local dates in `tz`. */
export function weekWindow(nowMs: number, tz: string, weeksBack: number): { from: string; to: string; label: "last week" | "this week" } {
  const wd = localParts(nowMs, tz).weekday;
  const mondayBack = (wd + 6) % 7;
  const iso = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return { from: iso(dateMinusDays(nowMs, tz, mondayBack + 7 * weeksBack)), to: iso(dateMinusDays(nowMs, tz, mondayBack + 7 * weeksBack - 6)), label: weeksBack === 0 ? "this week" : "last week" };
}

export function parseMeetingRequest(message: string, opts: ParseOptions): MeetingRequest | null {
  const focus = opts.focus;
  const hasWord = MEETING_WORD.test(message);
  // Without the word "meeting", a question is a meeting question only when a meeting is already what the conversation is about.
  const looseTalk = !hasWord && !focus && PAST_TALK.test(message) && DATEISH.test(message) && !NOT_ABOUT_MEETINGS.test(message);
  if (!hasWord && !focus && !looseTalk) return null;
  if (!hasWord && !looseTalk && NOT_ABOUT_MEETINGS.test(message)) return null;
  const kinds = {
    decisions: KIND.decisions.test(message) || (!!focus && FOLLOW.decisions.test(message)),
    action: KIND.action.test(message) || (hasWord && FOLLOW.pending.test(message)) || (!!focus && (FOLLOW.owners.test(message) || FOLLOW.pending.test(message))),
    summary: KIND.summary.test(message) || (!!focus && FOLLOW.summary.test(message)),
    content: KIND.content.test(message),
  };
  if (looseTalk && !kinds.decisions) kinds.summary = true;
  if (hasWord && !kinds.decisions && !kinds.action && !kinds.summary && !kinds.content && FETCH_ASK.test(message) && (/\bnotion\b/i.test(message) || /\b(?:pull|fetch|retrieve)\b/i.test(message))) kinds.summary = true;
  const asksPrevious = !!focus && PREVIOUS.test(message) && (hasWord || /\b(one|call|session)\b|what about/i.test(message));
  const asksNext = !asksPrevious && !!focus && NEXT.test(message) && (hasWord || /\b(one|call|session)\b|what about/i.test(message));
  const asksThis = !!focus && THIS_MEETING.test(message);
  const asksTopic = !!focus && !asksPrevious && !asksNext && (CHANGED.test(message) || DISCUSSED.test(message) || (AGREED.test(message) && ABOUT.test(message)));
  const anyKind = kinds.decisions || kinds.action || kinds.summary || kinds.content;
  if (!anyKind && !asksPrevious && !asksNext && !asksTopic) return null;

  const named = Object.entries(kinds).filter(([, v]) => v).map(([k]) => k);
  let output: MeetingOutput = named.length !== 1 ? "all" : named[0] === "decisions" ? "decisions" : named[0] === "action" ? "action_items" : named[0] === "content" ? "content" : "summary";
  // "What about the previous one?" with no kind named keeps the kind of the last answer.
  if (named.length === 0 && focus) output = focus.output === "content" ? "summary" : focus.output;
  const intent: MeetingIntent = output === "all" ? "meeting_all" : (`meeting_${output}` as MeetingIntent);
  const narrow: MeetingRequest["narrow"] = !focus && !hasWord ? undefined : FOLLOW.pending.test(message) ? "pending" : FOLLOW.owners.test(message) && /\b(who|owner|owners|responsible|assigned|accountable)\b/i.test(message) ? "owners" : undefined;
  const brief = BRIEF.test(message);

  const { rest: afterQuote, title } = takeQuoted(message);
  let text = afterQuote;
  const consume = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m) text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
    return m;
  };

  // --- time zone (named explicitly, otherwise the configured default) ---
  let tz = isValidTimeZone(opts.tz) ? opts.tz : "UTC";
  let tzLabel = tz;
  let tzExplicit = false;
  const abbr = consume(/\b(UTC|GMT|IST|EST|EDT|PST|PDT|CST|CDT|MST|MDT|CET)\b/);
  if (abbr) { const z = TZ_ABBREVIATIONS[abbr[1]]!; tz = z.zone; tzLabel = z.label; tzExplicit = true; }
  else {
    const iana = consume(/\b([A-Z][A-Za-z]+\/[A-Z][A-Za-z_]+)\b/);
    if (iana && isValidTimeZone(iana[1])) { tz = iana[1]; tzLabel = iana[1]; tzExplicit = true; }
  }

  let date: MeetingDate | undefined;
  let clarify: string | undefined;

  // --- date ---
  const iso = consume(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const dmy = iso ? null : consume(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  const mdy = iso || dmy ? null : consume(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  const numeric = iso || dmy || mdy ? null : consume(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const setDate = (month: number, day: number, year?: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31 || (year !== undefined && !validDate(year, month, day)) || (year === undefined && !validDate(2024, month, day))) {
      clarify = "That date does not exist. Which day did you mean?";
      return;
    }
    date = { month, day, ...(year !== undefined ? { year } : {}) };
  };
  if (iso) setDate(Number(iso[2]), Number(iso[3]), Number(iso[1]));
  else if (dmy) setDate(monthNumber(dmy[2]), Number(dmy[1]), dmy[3] ? Number(dmy[3]) : undefined);
  else if (mdy) setDate(monthNumber(mdy[1]), Number(mdy[2]), mdy[3] ? Number(mdy[3]) : undefined);
  else if (numeric) {
    const a = Number(numeric[1]), b = Number(numeric[2]);
    const year = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : undefined;
    if (a > 12 && b <= 12) setDate(b, a, year);
    else if (b > 12 && a <= 12) setDate(a, b, year);
    else if (a === b) setDate(a, b, year);
    else clarify = `${numeric[0]} could be ${a} ${monthName(b)} or ${b} ${monthName(a)}. Which one did you mean? Please write the month as a word, for example "23 October".`;
  } else {
    const nowMs = opts.now.getTime();
    if (consume(/\bday before yesterday\b/i)) date = pickRelative(nowMs, tz, 2);
    else if (consume(/\byesterday\b/i)) date = pickRelative(nowMs, tz, 1);
    else if (consume(/\btoday\b/i)) date = pickRelative(nowMs, tz, 0);
    else {
      const last = consume(new RegExp(`\\blast\\s+${WEEKDAY_RE}\\b`, "i"));
      const on = last ? null : consume(new RegExp(`\\b(?:on\\s+)?${WEEKDAY_RE}\\b`, "i"));
      const wd = last ?? on;
      if (wd) {
        const target = WEEKDAYS.indexOf(wd[1].toLowerCase());
        const today = localParts(nowMs, tz).weekday;
        let back = (today - target + 7) % 7;
        if (last && back === 0) back = 7;
        date = pickRelative(nowMs, tz, back);
      }
    }
  }

  // --- a week ("last week", "this week") ---
  let window: MeetingRequest["window"];
  if (!date) {
    if (consume(/\blast week(?:'s)?\b|\bprevious week(?:'s)?\b|\bpast week\b/i)) window = weekWindow(opts.now.getTime(), tz, 1);
    else if (consume(/\bthis week(?:'s)?\b/i)) window = weekWindow(opts.now.getTime(), tz, 0);
  }

  // --- time of day ---
  let time: MeetingRequest["time"];
  const ampm = consume(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
  if (ampm) {
    const h = Number(ampm[1]), mi = ampm[2] ? Number(ampm[2]) : 0;
    if (h < 1 || h > 12 || mi > 59) clarify ??= "I could not read that time. Please write it like 1 PM or 13:00.";
    else time = { hour: (h % 12) + (ampm[3].toLowerCase() === "p" ? 12 : 0), minute: mi };
  } else {
    const h24 = consume(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (h24) time = { hour: Number(h24[1]), minute: Number(h24[2]) };
  }

  // "last / latest / most recent" with no date names the newest meeting that already happened.
  const latest = !date && !window && !asksPrevious && !asksNext && /\b(last|latest|most recent|previous|recent)\b/i.test(text);

  // --- keywords: what is left after dates, times and common words ---
  const raw = text.replace(/[^A-Za-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const keywords: string[] = [];
  const meetingAt = raw.findIndex((w) => /^meetings?$/i.test(w));
  raw.forEach((w, i) => {
    const lower = w.toLowerCase();
    if (!/^[a-z0-9-]+$/i.test(w) || /^\d+$/.test(w)) return;
    const shortOk = w.length >= 3 || (w.length === 2 && w === w.toUpperCase());
    if (!shortOk) return;
    const nearMeeting = meetingAt >= 0 && Math.abs(i - meetingAt) <= 2 && KEEP_IF_ADJACENT_TO_MEETING.has(lower);
    if (STOP.has(lower) && !nearMeeting) return;
    if (MONTHS.some((m) => m.startsWith(lower) && lower.length >= 3) || WEEKDAYS.includes(lower)) return;
    if (!keywords.includes(lower)) keywords.push(lower);
  });

  // In a follow-up ("who owns that?", "give me a short summary") the leftover words are conversation, not a meeting title: they must not narrow the search.
  const followMode = !!focus && !title && (!hasWord || asksThis || asksPrevious || asksNext);
  if (followMode) keywords.length = 0;

  // A question about a topic across meetings: the terms come from what was asked, or, for "this" / "that" / "it", from what the focused meeting was about.
  let topic: MeetingRequest["topic"];
  if (asksTopic && !asksThis) {
    const about = ABOUT.exec(afterQuote)?.[1];
    const asked = about ? termsOf(about) : [];
    const fromWords = asked.length > 0 ? asked : keywords.length > 0 && !/\b(this|that|it)\b/i.test(afterQuote) ? keywords : [];
    const terms = fromWords.length > 0 ? fromWords : focus!.topics;
    if (terms.length > 0) topic = { terms: terms.slice(0, 6), when: CHANGED.test(message) ? "later" : window ? "window" : "any", asks: AGREED.test(message) && !DISCUSSED.test(message) ? "agreed" : "discussed", derived: fromWords.length === 0 };
  }
  const target: MeetingRequest["target"] = topic ? undefined : asksPrevious ? "previous" : asksNext ? "next" : focus && !date && !window && !title && keywords.length === 0 && !latest ? "focus" : undefined;
  if (asksTopic && !topic && !target) return null;

  return {
    intent, output, ...(date ? { date } : {}), ...(time ? { time } : {}), tz, tz_label: tzLabel, tz_explicit: tzExplicit,
    keywords: keywords.slice(0, 8), ...(title ? { exact_title: title } : {}), latest, ...(clarify ? { clarify } : {}),
    ...(window ? { window } : {}), ...(target ? { target } : {}), ...(topic ? { topic } : {}), brief, ...(narrow ? { narrow } : {}),
  };
}

/** Content words of a phrase ("the marketplace launch") for searching meeting text. */
export function termsOf(phrase: string): string[] {
  const out: string[] = [];
  for (const w of phrase.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || MONTHS.some((m) => m.startsWith(w) && w.length >= 3) || WEEKDAYS.includes(w) || /^\d+$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function pickRelative(nowMs: number, tz: string, daysBack: number): MeetingDate {
  const d = dateMinusDays(nowMs, tz, daysBack);
  return { month: d.month, day: d.day, year: d.year };
}
