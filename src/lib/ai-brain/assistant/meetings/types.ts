import type { ConnectorFailure } from "../connectors";

/**
 * Source-neutral meeting types. Notion is the first source; Outlook Calendar, Teams or another system would produce the same shapes
 * from its own connector, and nothing below this file (analysis, validation, formatting) knows which system a meeting came from.
 */

export type MeetingSystem = "notion";

/** One located meeting record. No content: finding a meeting reads titles and dates only. */
export interface MeetingCandidate {
  system: MeetingSystem;
  record_id: string;
  title: string;
  url?: string;
  last_edited?: string;
  /** The page or database that contains this record, when the source reports one (organization-resource policy only; never shown). */
  parent_id?: string;
  /**
   * When the meeting happened: a UTC instant (ISO) when the source gives a time of day, or a plain "YYYY-MM-DD" when it gives only a date.
   * From a date property if the record has one, otherwise the creation time.
   */
  starts_at?: string;
  /** The date has no time of day, so a requested time cannot be checked against it. */
  date_only: boolean;
  date_source: "date_property" | "created_time" | "none";
  retrieved_at: string;
}

export type SegmentKind = "title" | "property" | "heading" | "text" | "todo" | "quote" | "table" | "subpage";

/** One unit of source text. `id` ("S1", "S2", ...) is what the model cites; `ref` is the source system's own block or property id. */
export interface SourceSegment {
  id: string;
  ref: string;
  kind: SegmentKind;
  text: string;
  depth: number;
  /** to-do checked state, when the source records one. */
  checked?: boolean;
  /** The text looked like an instruction (prompt-injection signal). It is shown as data and is never sent to a model. */
  flagged?: boolean;
}

export type CoverageGap = "block_limit" | "depth_limit" | "time_limit" | "request_limit" | "unreadable_children" | "rate_limited" | "model_input_limit";

export interface Coverage {
  complete: boolean;
  gaps: CoverageGap[];
  blocks_read: number;
}

/** A meeting record with its full (bounded) content, normalized into segments. */
export interface MeetingDocument extends Omit<MeetingCandidate, "retrieved_at"> {
  retrieved_at: string;
  segments: SourceSegment[];
  coverage: Coverage;
}

export type MeetingResult<T> = { ok: true; data: T } | { ok: false; reason: ConnectorFailure };

export const GAP_TEXT: Record<CoverageGap, string> = {
  block_limit: "the page is longer than the 800-block limit",
  depth_limit: "some deeply nested content was not opened",
  time_limit: "reading hit the time limit",
  request_limit: "reading hit the request limit",
  unreadable_children: "some nested content could not be read",
  rate_limited: "Notion rate limited part of the read",
  model_input_limit: "only the first part of the text was analysed",
};
