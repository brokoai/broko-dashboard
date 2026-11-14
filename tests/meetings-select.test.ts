import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMeetingRequest } from "../src/lib/ai-brain/assistant/meetings/request";
import type { MeetingCandidate } from "../src/lib/ai-brain/assistant/meetings/types";
import { selectMeetings } from "../src/lib/ai-brain/chat/meetings";

// Found by a real user test: "What action items came out of the meeting on 29 October at 8:10 PM?" matched nothing, because
// "came" and "out" became mandatory title keywords and the time was read in UTC instead of the organisation's zone.
const NOW = new Date("2026-11-03T13:30:00Z");
const cand = (title: string, iso: string): MeetingCandidate => ({ system: "notion", record_id: `id-${title}`, title, starts_at: iso, date_only: false, date_source: "created_time", retrieved_at: NOW.toISOString() });
const ALL = [cand("Meeting 2026-10-29T20:10:00.000+05:30", "2026-10-29T14:40:00.000Z"), cand("Meeting 2026-10-29T20:03:00.000+05:30", "2026-10-29T14:33:00.000Z"), cand("Meeting 2026-11-01T16:16:00.000+05:30", "2026-11-01T10:46:00.000Z")];
const Q = "What action items came out of the meeting on 29 October at 8:10 PM?";

describe("meeting selection with natural wording and the organisation time zone", () => {
  it("conversational words are not title keywords", () => {
    assert.deepEqual(parseMeetingRequest(Q, { now: NOW, tz: "Asia/Kolkata" })?.keywords, []);
  });

  it("in the organisation's zone the 8:10 PM meeting is found, and only that one", () => {
    const req = parseMeetingRequest(Q, { now: NOW, tz: "Asia/Kolkata" })!;
    assert.deepEqual(selectMeetings(ALL, req, NOW).matches.map((c) => c.title), ["Meeting 2026-10-29T20:10:00.000+05:30"]);
  });

  it("read in UTC the same question honestly matches nothing (the reply names the zone it used)", () => {
    const req = parseMeetingRequest(Q, { now: NOW, tz: "UTC" })!;
    assert.equal(selectMeetings(ALL, req, NOW).matches.length, 0);
  });

  it("with a date, an unmatched leftover word no longer hides the meeting the date identifies", () => {
    const req = { ...parseMeetingRequest(Q, { now: NOW, tz: "Asia/Kolkata" })!, keywords: ["roadmap"] };
    assert.equal(selectMeetings(ALL, req, NOW).matches.length, 1);
  });

  it("without a date, keywords stay strict: asking for a topic that no title mentions finds nothing, not the latest meeting", () => {
    const req = parseMeetingRequest("Summarize the pricing meeting", { now: NOW, tz: "Asia/Kolkata" })!;
    assert.ok(req.keywords.includes("pricing"));
    assert.equal(selectMeetings(ALL, req, NOW).matches.length, 0);
  });
});

describe("ambiguous times still ask", () => {
  it("two meetings equally close to the time given are not guessed between", () => {
    const two = [cand("Meeting A", "2026-10-29T14:35:00.000Z"), cand("Meeting B", "2026-10-29T14:47:00.000Z")]; // 20:05 and 20:17 IST, asked 20:10
    const req = parseMeetingRequest(Q, { now: NOW, tz: "Asia/Kolkata" })!;
    assert.equal(selectMeetings(two, req, NOW).matches.length, 2);
  });
});
