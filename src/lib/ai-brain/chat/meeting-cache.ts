import type { MeetingView } from "../assistant/meetings/analysis";
import type { CoverageGap, MeetingDocument } from "../assistant/meetings/types";

/**
 * A short-lived, per-process memory of meetings that were just read and analysed, so a follow-up ("who owns that?") in the same conversation
 * does not read Notion and call the model again (which would use up the user's analysis budget on the same page).
 *
 * Safety: an entry is keyed by the signed-in user AND the page's last-edited time, which is taken from a fresh search on every request, so
 * an edited page is never served from here and another user never sees it. It is consulted only AFTER the normal authorization and search
 * steps have succeeded, so it never widens access. It expires after ten minutes and holds the already-sanitised text only in server memory.
 * Absent from the context (the default, and in tests unless injected) means no caching at all.
 */

export interface CachedMeeting { doc: MeetingDocument; view: MeetingView; extra_gaps: CoverageGap[]; notes: string[] }

export interface MeetingCache {
  get(key: string): CachedMeeting | undefined;
  set(key: string, value: CachedMeeting): void;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 30;

export function createMeetingCache(now: () => number = Date.now): MeetingCache {
  const entries = new Map<string, { at: number; value: CachedMeeting }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > TTL_MS) { entries.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    },
  };
}

/** One per server process. Handed to the chat by the server action only. */
export const sharedMeetingCache: MeetingCache = createMeetingCache();

export const cacheKey = (userId: string, recordId: string, lastEdited: string | undefined): string | null =>
  lastEdited ? `${userId}|${recordId}|${lastEdited}` : null;
