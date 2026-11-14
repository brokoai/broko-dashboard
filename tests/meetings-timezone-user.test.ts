import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { timeZoneFor } from "../src/lib/ai-brain/assistant/meetings/datetime";
import { parseMeetingRequest } from "../src/lib/ai-brain/assistant/meetings/request";
import type { MeetingCandidate } from "../src/lib/ai-brain/assistant/meetings/types";
import { selectMeetings } from "../src/lib/ai-brain/chat/meetings";

// A user in Canada or the USA means their own clock when they write "8:10 PM". The organisation default (India) must not override it.
const NOW = new Date("2026-11-03T13:30:00Z");
const cand = (title: string, iso: string): MeetingCandidate => ({ system: "notion", record_id: `id-${title}`, title, starts_at: iso, date_only: false, date_source: "created_time", retrieved_at: NOW.toISOString() });
const ORG = { BROKO_TIMEZONE: "Asia/Kolkata" };

describe("per-user time zone", () => {
  it("a valid browser zone beats the organisation default", () => {
    assert.equal(timeZoneFor("America/Toronto", ORG), "America/Toronto");
    assert.equal(timeZoneFor("America/Los_Angeles", ORG), "America/Los_Angeles");
  });

  it("missing, empty or invalid browser zones fall back to the organisation default", () => {
    for (const bad of [undefined, null, "", "Not/AZone", "x".repeat(200), "../etc/passwd", "America/Toronto; DROP", 42, {}]) {
      assert.equal(timeZoneFor(bad, ORG), "Asia/Kolkata", String(bad));
    }
  });

  it("with no browser zone and no valid organisation zone, nothing is assumed (parser reads UTC and says so)", () => {
    assert.equal(timeZoneFor(undefined, {}), undefined);
    assert.equal(timeZoneFor(undefined, { BROKO_TIMEZONE: "Mars/Base" }), undefined);
  });

  it("the same 8:10 PM question finds the Toronto user's meeting, not the India one", () => {
    // 8:10 PM Toronto (EDT, UTC-4 on 29 Oct) = 2026-10-30T00:10Z; 8:10 PM India = 14:40Z.
    const toronto = cand("Toronto standup", "2026-10-30T00:10:00.000Z");
    const india = cand("India standup", "2026-10-29T14:40:00.000Z");
    const q = "What action items came out of the meeting on 29 October at 8:10 PM?";

    const reqCA = parseMeetingRequest(q, { now: NOW, tz: timeZoneFor("America/Toronto", ORG)! })!;
    assert.equal(reqCA.tz, "America/Toronto");
    assert.deepEqual(selectMeetings([toronto, india], reqCA, NOW).matches.map((c) => c.title), ["Toronto standup"]);

    const reqIN = parseMeetingRequest(q, { now: NOW, tz: timeZoneFor(undefined, ORG)! })!;
    assert.deepEqual(selectMeetings([toronto, india], reqIN, NOW).matches.map((c) => c.title), ["India standup"]);
  });

  it("a Pacific user's relative dates follow their calendar day", () => {
    // 2026-11-03T03:00Z is still 2 November in Los Angeles but already 3 November in Kolkata.
    const late = new Date("2026-11-03T03:00:00Z");
    const la = parseMeetingRequest("summarize the meeting from today", { now: late, tz: "America/Los_Angeles" })!;
    const kol = parseMeetingRequest("summarize the meeting from today", { now: late, tz: "Asia/Kolkata" })!;
    assert.equal(la.date?.day, 2);
    assert.equal(kol.date?.day, 3);
  });

  it("a typo like 'summoray' still reads as a meeting summary request for yesterday", () => {
    for (const word of ["summoray", "sumary", "summarry", "summary"]) {
      const r = parseMeetingRequest(`${word} of yesterday meeting in notion`, { now: NOW, tz: "Asia/Kolkata" });
      assert.ok(r, word);
      assert.equal(r!.output, "summary", word);
      assert.equal(r!.date?.day, 2, word);
    }
  });

  it("US zone abbreviations typed in the question are understood (Central, Mountain)", () => {
    for (const [abbr, zone] of [["CST", "America/Chicago"], ["CDT", "America/Chicago"], ["MST", "America/Denver"], ["MDT", "America/Denver"], ["PST", "America/Los_Angeles"], ["EST", "America/New_York"]]) {
      const r = parseMeetingRequest(`summarize the meeting on 29 October at 8:10 PM ${abbr}`, { now: NOW, tz: "Asia/Kolkata" })!;
      assert.equal(r.tz, zone, abbr);
      assert.equal(r.tz_explicit, true);
    }
  });
});
