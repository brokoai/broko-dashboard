import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localParts, validDate, zonedToUtc } from "../src/lib/ai-brain/assistant/meetings/datetime";
import { parseMeetingRequest, type MeetingRequest } from "../src/lib/ai-brain/assistant/meetings/request";

// 2026-10-25 is a Sunday. All parsing here is deterministic: no model, no network.
const NOW = new Date("2026-10-25T12:00:00Z");
const parse = (m: string, tz = "UTC", now = NOW): MeetingRequest => {
  const r = parseMeetingRequest(m, { now, tz });
  assert.ok(r, `expected a meeting request: ${m}`);
  return r;
};

describe("A. natural-language meeting intent", () => {
  it("the spec examples map to the right intent, date and time", () => {
    const a = parse("What was discussed in the meeting on 23 October at 1 PM?");
    assert.equal(a.intent, "meeting_summary");
    assert.deepEqual(a.date, { month: 10, day: 23 }); // no year invented
    assert.deepEqual(a.time, { hour: 13, minute: 0 });
    const b = parse("Summarize yesterday's meeting.");
    assert.equal(b.intent, "meeting_summary");
    assert.deepEqual(b.date, { month: 10, day: 24, year: 2026 });
    const c = parse("What decisions were made in our last client meeting?");
    assert.equal(c.intent, "meeting_decisions");
    assert.equal(c.latest, true);
    assert.equal(c.date, undefined);
    assert.ok(c.keywords.includes("client"));
    const d = parse("Extract all action items from the meeting with the marketing team.");
    assert.equal(d.intent, "meeting_action_items");
    assert.deepEqual(d.keywords, ["marketing"]);
    const e = parse("Show me the meeting summary and important follow-ups.");
    assert.equal(e.intent, "meeting_all");
  });

  it("who-was-assigned and agreed-in-the-meeting questions are action-item and decision requests", () => {
    assert.equal(parse("Who was assigned the pending tasks in the meeting?").intent, "meeting_action_items");
    assert.equal(parse("What did we agree in the meeting about the timeline?").intent, "meeting_decisions");
  });

  it("questions that do not mention a meeting are not meeting requests (no hijacking)", () => {
    for (const m of ["What did we agree about the project timeline?", "What are my pending tasks?", "Summarize what happened today.", "Search Notion for onboarding"]) {
      assert.equal(parseMeetingRequest(m, { now: NOW, tz: "UTC" }), null, m);
    }
    // a meeting word with no request for notes, decisions or tasks is not one either
    assert.equal(parseMeetingRequest("Is there a meeting room free?", { now: NOW, tz: "UTC" }), null);
  });

  it("keywords keep title words and drop question words, months and weekdays", () => {
    const r = parse("Summarize the AI Automation Partnership and Hyperlocal Marketplace MVP meeting.");
    assert.deepEqual(r.keywords, ["ai", "automation", "partnership", "hyperlocal", "marketplace", "mvp"]);
    assert.deepEqual(parse("Summarize the meeting on 23 October at 1 PM").keywords, []);
  });

  it("a quoted title is a literal: it is never parsed for dates, times or keywords", () => {
    const r = parse('Summarize the meeting "Meeting @Last Sunday 4:16 PM"');
    assert.equal(r.exact_title, "Meeting @Last Sunday 4:16 PM");
    assert.equal(r.date, undefined);
    assert.equal(r.time, undefined);
    assert.equal(r.latest, false);
    assert.deepEqual(r.keywords, []);
  });
});

describe("B. date and time parsing", () => {
  it("reads day-month, month-day, ordinals and ISO dates; a missing year stays missing", () => {
    assert.deepEqual(parse("Summarize the meeting on 23 October").date, { month: 10, day: 23 });
    assert.deepEqual(parse("Summarize the meeting on Oct 23rd").date, { month: 10, day: 23 });
    assert.deepEqual(parse("Summarize the meeting on 23rd of October 2025").date, { month: 10, day: 23, year: 2025 });
    assert.deepEqual(parse("Summarize the meeting on 2026-10-23").date, { month: 10, day: 23, year: 2026 });
    assert.deepEqual(parse("Summarize the meeting on 13/10/2026").date, { month: 10, day: 13, year: 2026 });
  });

  it("an ambiguous numeric date is a question, not an assumption", () => {
    const r = parse("Summarize the meeting on 3/4");
    assert.ok(r.clarify && /3 April or 4 March/.test(r.clarify));
    assert.equal(r.date, undefined);
    assert.ok(parse("Summarize the meeting on 30 February").clarify, "a date that does not exist is refused");
  });

  it("reads 12-hour and 24-hour times, including noon and midnight", () => {
    assert.deepEqual(parse("Summarize the meeting at 1 PM").time, { hour: 13, minute: 0 });
    assert.deepEqual(parse("Summarize the meeting at 4:16 pm").time, { hour: 16, minute: 16 });
    assert.deepEqual(parse("Summarize the meeting at 12 AM").time, { hour: 0, minute: 0 });
    assert.deepEqual(parse("Summarize the meeting at 12 PM").time, { hour: 12, minute: 0 });
    assert.deepEqual(parse("Summarize the meeting at 13:30").time, { hour: 13, minute: 30 });
    assert.ok(parse("Summarize the meeting at 13 PM").clarify);
  });

  it("relative days are computed from now: yesterday, today, last Sunday, a bare weekday", () => {
    assert.deepEqual(parse("Summarize today's meeting").date, { month: 10, day: 25, year: 2026 });
    assert.deepEqual(parse("Summarize the day before yesterday's meeting").date, { month: 10, day: 23, year: 2026 });
    assert.deepEqual(parse("Summarize the meeting last Sunday").date, { month: 10, day: 18, year: 2026 }, "now is a Sunday, so 'last Sunday' is a week ago");
    assert.deepEqual(parse("Summarize the meeting on Friday").date, { month: 10, day: 23, year: 2026 });
  });
});

describe("C. time zone handling", () => {
  it("uses the configured zone for relative days: 20:00 UTC is already tomorrow in India", () => {
    const late = new Date("2026-10-25T20:00:00Z");
    assert.deepEqual(parse("Summarize today's meeting", "Asia/Kolkata", late).date, { month: 10, day: 26, year: 2026 });
    assert.deepEqual(parse("Summarize today's meeting", "UTC", late).date, { month: 10, day: 25, year: 2026 });
  });

  it("an explicit zone in the question wins and is reported as explicit", () => {
    const r = parse("Summarize the meeting on 23 October at 1 PM IST");
    assert.equal(r.tz, "Asia/Kolkata");
    assert.equal(r.tz_explicit, true);
    assert.deepEqual(r.time, { hour: 13, minute: 0 });
    assert.equal(parse("Summarize the meeting at 1 PM Europe/Berlin").tz, "Europe/Berlin");
    const d = parse("Summarize the meeting at 1 PM");
    assert.equal(d.tz_explicit, false);
    assert.equal(d.tz, "UTC");
  });

  it("an invalid configured zone falls back to UTC instead of throwing", () => {
    assert.equal(parse("Summarize the meeting at 1 PM", "Not/AZone").tz, "UTC");
  });

  it("wall-clock to instant conversion respects the zone and daylight saving", () => {
    assert.equal(zonedToUtc(2026, 10, 23, 13, 0, "Asia/Kolkata"), Date.UTC(2026, 9, 23, 7, 30));
    assert.equal(zonedToUtc(2026, 10, 23, 13, 0, "America/New_York"), Date.UTC(2026, 9, 23, 17, 0)); // EDT, UTC-4
    assert.equal(zonedToUtc(2026, 12, 23, 13, 0, "America/New_York"), Date.UTC(2026, 11, 23, 18, 0)); // EST, UTC-5
    const p = localParts(Date.UTC(2026, 9, 23, 7, 30), "Asia/Kolkata");
    assert.deepEqual([p.month, p.day, p.hour, p.minute], [10, 23, 13, 0]);
    assert.equal(validDate(2026, 2, 30), false);
    assert.equal(validDate(2028, 2, 29), true);
  });
});
